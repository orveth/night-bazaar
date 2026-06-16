//! Multi-unit accept: issue a charge challenge in WHICHEVER currently-valid
//! `pop_<ts>` unit the client declares it holds, without touching the verifier.
//!
//! ## Why this exists
//!
//! `pops-core-verify`'s `CashuRequirement.unit` is SCALAR and the swap check is
//! strict (`cashu_credential.rs`: `token_unit != requirement.unit` → wrong-unit
//! 402). One [`ChargeMiddlewareState`] therefore accepts exactly ONE unit. But
//! `pop_<ts>` units ROTATE and rotations OVERLAP, so at any moment several units
//! are simultaneously valid (see [`crate::mint`]). gudnuf's requirement: "add
//! new units, but still accept all old but valid units": a returning player
//! whose token is in yesterday's still-valid unit must not be cut off.
//!
//! ## How it works (verifier untouched)
//!
//! For each gate we hold a SET of per-unit [`ChargeMiddlewareState`]s, one per
//! currently-valid unit, ALL sharing the same [`BindingKey`] and TTL. A thin
//! dispatch middleware ([`require_charge_multi`]):
//!   1. reads the client-declared unit (the `unit` query param, falling back to
//!      the [`UNIT_HEADER`] header),
//!   2. validates it is in the live valid set (else a clear "mint the current
//!      unit" 409),
//!   3. looks up that unit's `ChargeMiddlewareState` and DELEGATES to the
//!      UNMODIFIED [`require_charge`] with it.
//!
//! So the audited challenge issuance / HMAC binding / swap / problem-mapping all
//! run exactly as before; we only choose WHICH unit's requirement applies. The
//! verifier still does its scalar `token_unit == requirement.unit` check per
//! challenge; we are not weakening it.
//!
//! The per-unit set is refreshable at runtime (the binary re-probes
//! `/v1/keysets` every few minutes). A unit drops the moment its `final_expiry`
//! passes; a fresh unit is added on rotation. In-flight requests are unaffected
//! (each clones its chosen state up front).

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use cashu::nuts::CurrencyUnit;
use cashu::{Amount, MintUrl};
use http::StatusCode;
use pops_core_verify::binding::BindingKey;
use pops_core_verify::cashu_credential::CashuCredential;
use pops_core_verify::cdk_mint_client::CdkMintClient;
use pops_core_verify::challenge::CashuRequirement;
use pops_core_verify::middleware::{require_charge, ChargeMiddlewareState};
use pops_core_verify::redeemer::Redeemer;
use serde_json::json;
use tracing::{info, warn};

use crate::mint::ValidUnits;

/// The header a header-capable client uses to declare the unit it holds. The
/// `?unit=` query param takes precedence (a CLI like `pop pay` cannot set
/// custom headers, and the browser payer appends the query param too).
pub const UNIT_HEADER: &str = "x-bazaar-unit";

/// The concrete credential type the live gates use (cdk-backed cashu).
pub type LiveCredential = CashuCredential<CdkMintClient>;

/// Per-gate facts needed to (re)build a unit's [`ChargeMiddlewareState`]: the
/// exact price and the issuance correlation fields. The mint allowlist, binding
/// key, and TTL are shared across all gates and units (held on
/// [`MultiUnitGates`]).
#[derive(Clone)]
pub struct GateSpec {
    pub gate_id: String,
    pub amount: u64,
    pub label: String,
}

/// The set of valid units plus, per gate, the per-unit charge states. Swapped
/// wholesale on each refresh behind a single [`RwLock`]; a dispatch reads it,
/// clones the one `Arc<ChargeMiddlewareState>` it needs, and releases the lock
/// before doing any awaiting.
struct Inner<C: Redeemer> {
    /// The currently-valid units (for membership checks + diagnostics).
    valid: ValidUnits,
    /// gate_id -> (unit -> charge state).
    by_gate: HashMap<String, HashMap<String, Arc<ChargeMiddlewareState<C>>>>,
}

/// Shared, refreshable multi-unit gate registry. One instance backs every
/// gate's dispatch layer (each layer also carries its own `gate_id`).
pub struct MultiUnitGates<C: Redeemer> {
    inner: RwLock<Arc<Inner<C>>>,
    /// Build inputs reused on refresh.
    specs: Vec<GateSpec>,
    public_mints: Vec<MintUrl>,
    binding_key: BindingKey,
    challenge_ttl: Duration,
    mint_timeout: Duration,
}

/// What a dispatch layer needs: the shared registry + which gate it guards.
pub struct GateDispatch<C: Redeemer> {
    pub gates: Arc<MultiUnitGates<C>>,
    pub gate_id: String,
}

impl<C: Redeemer> Clone for GateDispatch<C> {
    fn clone(&self) -> Self {
        Self {
            gates: self.gates.clone(),
            gate_id: self.gate_id.clone(),
        }
    }
}

impl MultiUnitGates<LiveCredential> {
    /// Build the registry for the current valid set. `public_mints` is the
    /// accepted-mints allowlist (also serialized into each creqA `m` list);
    /// `binding_key` is shared so challenges survive a refresh and a restart
    /// (when operator-configured).
    pub fn new(
        valid: ValidUnits,
        specs: Vec<GateSpec>,
        public_mints: Vec<MintUrl>,
        binding_key: BindingKey,
        challenge_ttl: Duration,
        mint_timeout: Duration,
    ) -> anyhow::Result<Arc<Self>> {
        let by_gate = build_states(
            &valid,
            &specs,
            &public_mints,
            &binding_key,
            challenge_ttl,
            mint_timeout,
        )?;
        Ok(Arc::new(Self {
            inner: RwLock::new(Arc::new(Inner { valid, by_gate })),
            specs,
            public_mints,
            binding_key,
            challenge_ttl,
            mint_timeout,
        }))
    }

    /// Rebuild the per-unit states from a fresh valid set (called by the
    /// re-probe loop). On any build error the OLD set is kept (a transient
    /// malformed probe must not blank the gates).
    pub fn refresh(&self, valid: ValidUnits) {
        match build_states(
            &valid,
            &self.specs,
            &self.public_mints,
            &self.binding_key,
            self.challenge_ttl,
            self.mint_timeout,
        ) {
            Ok(by_gate) => {
                let new_units = valid.unit_strings();
                let mut guard = self.inner.write().expect("multiunit lock poisoned");
                let old_units = guard.valid.unit_strings();
                *guard = Arc::new(Inner { valid, by_gate });
                if new_units != old_units {
                    info!(
                        ?old_units,
                        ?new_units,
                        "valid pop-unit set changed on refresh"
                    );
                }
            }
            Err(e) => warn!("unit refresh failed, keeping the previous valid set: {e}"),
        }
    }
}

impl<C: Redeemer> MultiUnitGates<C> {
    /// Build a registry from PRE-BUILT per-gate per-unit states (no mint
    /// client). The generic path used by tests and by any non-cdk credential;
    /// the live binary uses [`MultiUnitGates::new`] (cdk-backed) instead.
    /// `refresh`/`new` are unavailable here (they need the cdk client), so a
    /// registry built this way is fixed for its lifetime.
    pub fn from_states(
        valid: ValidUnits,
        by_gate: HashMap<String, HashMap<String, Arc<ChargeMiddlewareState<C>>>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(Arc::new(Inner { valid, by_gate })),
            // These fields only feed `new`/`refresh` (the cdk path); unused here.
            specs: Vec::new(),
            public_mints: Vec::new(),
            binding_key: BindingKey::generate(),
            challenge_ttl: Duration::ZERO,
            mint_timeout: Duration::ZERO,
        })
    }

    /// Snapshot the currently-valid units (for `/api/config` + the boot log).
    pub fn valid_units(&self) -> ValidUnits {
        self.inner
            .read()
            .expect("multiunit lock poisoned")
            .valid
            .clone()
    }

    /// The charge state for `(gate_id, unit)` if the unit is currently valid.
    /// Clones the `Arc` and the live valid set under a brief read lock.
    fn resolve(&self, gate_id: &str, unit: &str) -> Resolve<C> {
        let guard = self.inner.read().expect("multiunit lock poisoned");
        if !guard.valid.contains(unit) {
            return Resolve::UnitNotValid {
                newest: guard.valid.newest.clone(),
                accepted: guard.valid.unit_strings(),
            };
        }
        match guard.by_gate.get(gate_id).and_then(|m| m.get(unit)) {
            Some(state) => Resolve::Found(state.clone()),
            // A valid unit with no built state is a server bug, not the
            // client's fault.
            None => Resolve::NoState,
        }
    }
}

enum Resolve<C: Redeemer> {
    Found(Arc<ChargeMiddlewareState<C>>),
    UnitNotValid {
        newest: String,
        accepted: Vec<String>,
    },
    NoState,
}

/// Build, for every gate, the per-unit `ChargeMiddlewareState` map over the
/// valid set. All states share `binding_key` + `challenge_ttl`; each gets its
/// own `CashuCredential` (the mint client is cheap + `Copy`).
fn build_states(
    valid: &ValidUnits,
    specs: &[GateSpec],
    public_mints: &[MintUrl],
    binding_key: &BindingKey,
    challenge_ttl: Duration,
    mint_timeout: Duration,
) -> anyhow::Result<HashMap<String, HashMap<String, Arc<ChargeMiddlewareState<LiveCredential>>>>> {
    let mut by_gate = HashMap::new();
    for spec in specs {
        let mut per_unit = HashMap::new();
        for u in &valid.units {
            let unit = CurrencyUnit::from_str(&u.unit)
                .map_err(|e| anyhow::anyhow!("unit {:?} rejected by cashu: {e}", u.unit))?;
            let requirement = CashuRequirement {
                unit,
                mints: public_mints.to_vec(),
                amount: Amount::from(spec.amount),
                external_id: Some(format!("bazaar:{}", spec.gate_id)),
                description: Some(format!("Night Bazaar - {}", spec.label)),
            };
            let state = ChargeMiddlewareState::new(
                requirement,
                CashuCredential::new(CdkMintClient::with_timeout(mint_timeout)),
            )
            .with_binding_key(binding_key.clone())
            .with_challenge_ttl(challenge_ttl);
            per_unit.insert(u.unit.clone(), Arc::new(state));
        }
        by_gate.insert(spec.gate_id.clone(), per_unit);
    }
    Ok(by_gate)
}

/// Read the client-declared unit: the `unit` query param first (works for a
/// header-less CLI like `pop pay` and for the browser payer, which appends it),
/// then the [`UNIT_HEADER`] header. A `pop_<ts>` unit is pure ASCII
/// (`pop_` + decimal digits), so a plain `&`/`=` split is sufficient; no
/// percent-decoding is needed for the values we accept.
fn declared_unit(req: &Request) -> Option<String> {
    if let Some(q) = req.uri().query() {
        if let Some(u) = query_param(q, "unit") {
            let t = u.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    req.headers()
        .get(UNIT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// First value of `key` in a raw `a=b&c=d` query string (no percent-decoding).
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then_some(v)
    })
}

/// The dispatch middleware. Picks the per-unit charge state for the declared
/// unit and delegates to the UNMODIFIED [`require_charge`]. When the client
/// declares no unit, the request falls through to the NEWEST valid unit (a
/// fresh player who built their wallet on the advertised unit need not declare
/// it). An out-of-set unit is a clear "mint the current unit" 409 BEFORE any
/// payment dance, so a held-but-expired token does not waste a swap.
pub async fn require_charge_multi<C>(
    State(dispatch): State<GateDispatch<C>>,
    req: Request,
    next: Next,
) -> Response
where
    C: Redeemer + Send + Sync + 'static,
{
    // No declared unit → use the newest valid unit (the advertised mint-into
    // one). This keeps the fresh-player path zero-config and back-compatible
    // with a client that does not send `?unit=`.
    let unit = match declared_unit(&req) {
        Some(u) => u,
        None => dispatch.gates.valid_units().newest,
    };

    match dispatch.gates.resolve(&dispatch.gate_id, &unit) {
        Resolve::Found(state) => require_charge::<C>(State(state), req, next).await,
        Resolve::UnitNotValid { newest, accepted } => mint_current_unit(&unit, &newest, &accepted),
        Resolve::NoState => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(http::header::CONTENT_TYPE, "application/problem+json")],
            json!({
                "type": "about:blank",
                "title": "unit-state-missing",
                "status": 500,
                "detail": format!("no charge state built for the valid unit {unit:?} (server bug)"),
            })
            .to_string(),
        )
            .into_response(),
    }
}

/// The "your token's unit has retired, mint the current one" response. A 409
/// (not a 402): the request is well-formed and we are not issuing a challenge in
/// a unit the client cannot use; the player must acquire the current unit first.
fn mint_current_unit(declared: &str, newest: &str, accepted: &[String]) -> Response {
    (
        StatusCode::CONFLICT,
        [(http::header::CONTENT_TYPE, "application/problem+json")],
        json!({
            "type": "about:blank",
            "title": "unit-retired",
            "status": 409,
            "detail": format!(
                "the unit you hold ({declared}) is no longer accepted; mint the current unit ({newest}) and retry"
            ),
            "currentUnit": newest,
            "acceptedUnits": accepted,
        })
        .to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mint::UnitInfo;

    fn valid_set(units: &[(&str, Option<u64>)], newest: &str) -> ValidUnits {
        ValidUnits {
            units: units
                .iter()
                .map(|(u, fe)| UnitInfo {
                    unit: u.to_string(),
                    final_expiry: *fe,
                })
                .collect(),
            newest: newest.to_string(),
        }
    }

    fn specs() -> Vec<GateSpec> {
        vec![
            GateSpec {
                gate_id: "spawn".into(),
                amount: 10,
                label: "spawn a body".into(),
            },
            GateSpec {
                gate_id: "court.crimson".into(),
                amount: 200,
                label: "Crimson Court entry".into(),
            },
        ]
    }

    fn gates_for(valid: ValidUnits) -> Arc<MultiUnitGates<LiveCredential>> {
        let mints = vec![MintUrl::from_str("https://mint.example").unwrap()];
        MultiUnitGates::new(
            valid,
            specs(),
            mints,
            BindingKey::from_hex(
                "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            )
            .unwrap(),
            Duration::from_secs(300),
            Duration::from_secs(10),
        )
        .unwrap()
    }

    #[test]
    fn resolve_finds_state_for_each_valid_unit_per_gate() {
        let valid = valid_set(
            &[("pop_1781713156", Some(1_781_705_956)), ("pop_1782300000", Some(1_782_290_000))],
            "pop_1782300000",
        );
        let gates = gates_for(valid);
        for gate in ["spawn", "court.crimson"] {
            for unit in ["pop_1781713156", "pop_1782300000"] {
                assert!(
                    matches!(gates.resolve(gate, unit), Resolve::Found(_)),
                    "gate {gate} unit {unit} must resolve"
                );
            }
        }
    }

    #[test]
    fn resolve_rejects_unit_outside_the_valid_set() {
        let valid = valid_set(&[("pop_1782300000", Some(1_782_290_000))], "pop_1782300000");
        let gates = gates_for(valid);
        // A perfectly-formed pop unit that simply is not (any longer) in the set.
        match gates.resolve("spawn", "pop_1781713156") {
            Resolve::UnitNotValid { newest, accepted } => {
                assert_eq!(newest, "pop_1782300000");
                assert_eq!(accepted, vec!["pop_1782300000".to_string()]);
            }
            _ => panic!("an out-of-set unit must be UnitNotValid"),
        }
    }

    #[test]
    fn refresh_adds_new_unit_and_drops_expired() {
        // Start with one unit, refresh to a set where it has dropped and a new
        // one appeared (the rotation story).
        let gates = gates_for(valid_set(
            &[("pop_1781713156", Some(1_781_705_956))],
            "pop_1781713156",
        ));
        assert!(matches!(gates.resolve("spawn", "pop_1781713156"), Resolve::Found(_)));
        assert!(matches!(
            gates.resolve("spawn", "pop_1782300000"),
            Resolve::UnitNotValid { .. }
        ));

        gates.refresh(valid_set(
            &[("pop_1782300000", Some(1_782_290_000))],
            "pop_1782300000",
        ));
        // The expired unit now rejects; the fresh unit resolves.
        assert!(matches!(
            gates.resolve("spawn", "pop_1781713156"),
            Resolve::UnitNotValid { .. }
        ));
        assert!(matches!(gates.resolve("spawn", "pop_1782300000"), Resolve::Found(_)));
        assert_eq!(gates.valid_units().newest, "pop_1782300000");
    }

    #[test]
    fn query_param_extracts_unit() {
        assert_eq!(query_param("unit=pop_1782300000", "unit"), Some("pop_1782300000"));
        assert_eq!(
            query_param("session=abc&unit=pop_1782300000", "unit"),
            Some("pop_1782300000")
        );
        assert_eq!(
            query_param("unit=pop_1&session=abc", "unit"),
            Some("pop_1")
        );
        assert_eq!(query_param("session=abc", "unit"), None);
        assert_eq!(query_param("", "unit"), None);
    }

    #[test]
    fn declared_unit_prefers_query_then_header() {
        use axum::body::Body;
        // query wins
        let req = Request::builder()
            .uri("/spawn?session=s&unit=pop_1782300000")
            .header(UNIT_HEADER, "pop_HEADER")
            .body(Body::empty())
            .unwrap();
        assert_eq!(declared_unit(&req).as_deref(), Some("pop_1782300000"));
        // header fallback when no query unit
        let req = Request::builder()
            .uri("/spawn?session=s")
            .header(UNIT_HEADER, "pop_1781713156")
            .body(Body::empty())
            .unwrap();
        assert_eq!(declared_unit(&req).as_deref(), Some("pop_1781713156"));
        // neither → None (dispatch falls back to newest)
        let req = Request::builder()
            .uri("/spawn")
            .body(Body::empty())
            .unwrap();
        assert_eq!(declared_unit(&req), None);
    }

    #[test]
    fn overlap_accepts_both_old_and_new_unit() {
        // gudnuf's requirement: a new unit is added while the old valid one is
        // still accepted (no mid-window cutoff).
        let gates = gates_for(valid_set(
            &[("pop_1781713156", Some(1_781_705_956)), ("pop_1782300000", Some(1_782_290_000))],
            "pop_1782300000",
        ));
        assert!(
            matches!(gates.resolve("spawn", "pop_1781713156"), Resolve::Found(_)),
            "the older-but-valid unit is still accepted"
        );
        assert!(
            matches!(gates.resolve("spawn", "pop_1782300000"), Resolve::Found(_)),
            "the newest unit is accepted"
        );
    }
}
