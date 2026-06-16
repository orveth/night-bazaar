//! End-to-end multi-unit accept: drives the REAL axum stack
//! (`gated_router_multi` -> `require_charge_multi` -> the UNMODIFIED
//! `require_charge`) over a mock `Redeemer` (no mint). Proves the contract's
//! "add new units, but still accept all old but valid units":
//!   * a gate request declaring an OLDER-but-valid unit gets a 402 whose creqA
//!     advertises THAT unit (not the newest), and a faithful pay in it → 200;
//!   * a request declaring a unit NOT in the valid set gets the clear
//!     `unit-retired` 409 before any payment dance;
//!   * a request declaring NO unit falls back to the newest unit.
//! The verifier is untouched — these tests only exercise WHICH unit's challenge
//! the dispatch layer chooses.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use http::{Request, StatusCode};
use tower::ServiceExt;

use night_bazaar_server::game::{AppState, Game, DEFAULT_GACHA_N};
use night_bazaar_server::gates::gated_router_multi;
use night_bazaar_server::mint::{UnitInfo, ValidUnits};
use night_bazaar_server::multiunit::MultiUnitGates;
use night_bazaar_server::protocol::{GameConfig, Mode, ServerMsg, SESSION_HEADER};
use night_bazaar_server::sink::RevenueSink;
use night_bazaar_server::vault::Vault;
use night_bazaar_server::world::default_world;

use pops_core_verify::challenge::{decode_charge_request, CashuRequirement};
use pops_core_verify::charge::{ChargeError, RedeemedProofs};
use pops_core_verify::envelope::{
    encode_payment_credentials, parse_payment_params, CashuPayload, EchoedChallenge, PaymentCredentials,
    PaymentParams,
};
use pops_core_verify::middleware::ChargeMiddlewareState;
use pops_core_verify::redeemer::{Redeemed, Redeemer};

const MINT: &str = "http://127.0.0.1:28338";
const OLDER: &str = "pop_1700000000"; // valid, earlier final_expiry
const NEWER: &str = "pop_1800000000"; // valid, latest final_expiry → newest
const GONE: &str = "pop_1699000000"; // a well-formed unit NOT in the valid set

// ---- Mock redeemer: succeeds for `cashuBmock:<amount>` in the requirement's
//      unit, double-spends on replay. Mirrors gate_flow.rs's mock. ----------

struct MockRedeemer {
    spent: Mutex<HashSet<String>>,
}
impl MockRedeemer {
    fn new() -> Self {
        Self {
            spent: Mutex::new(HashSet::new()),
        }
    }
}
#[async_trait]
impl Redeemer for MockRedeemer {
    async fn verify_and_redeem(
        &self,
        presented: &str,
        req: &pops_core_verify::redeemer::ChargeRequirement,
    ) -> Result<Redeemed, ChargeError> {
        let amount: u64 = presented
            .strip_prefix("cashuBmock:")
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| ChargeError::MalformedCredential("not a mock token".into()))?;
        if !self.spent.lock().unwrap().insert(presented.to_string()) {
            return Err(ChargeError::DoubleSpend);
        }
        if amount < req.amount {
            return Err(ChargeError::PaymentInsufficient {
                required: req.amount,
                presented: amount,
                amount: req.amount,
                expected_swap_fee: 0,
            });
        }
        Ok(Redeemed {
            unit: req.unit.clone(),
            amount,
            proofs: RedeemedProofs {
                fresh_proofs: "cashuBfresh".into(),
                amount,
                unit: req.unit.clone(),
                active_keyset_id: "01aa".into(),
                token_hash: "cafe".into(),
            },
            dleq_ok: true,
        })
    }
}

fn requirement(unit: &str, amount: u64, gate: &str) -> CashuRequirement {
    use std::str::FromStr;
    CashuRequirement {
        unit: cashu::nuts::CurrencyUnit::from_str(unit).unwrap(),
        mints: vec![cashu::MintUrl::from_str(MINT).unwrap()],
        amount: cashu::Amount::from(amount),
        external_id: Some(format!("bazaar:{gate}")),
        description: None,
    }
}

/// A `MultiUnitGates<MockRedeemer>` with the two valid units, built per
/// (gate x unit). Only the gates the tests hit (`spawn`) need entries, but we
/// build the full set the binary would.
fn multi_gates() -> Arc<MultiUnitGates<MockRedeemer>> {
    let valid = ValidUnits {
        units: vec![
            UnitInfo {
                unit: OLDER.into(),
                final_expiry: Some(1_700_000_000),
            },
            UnitInfo {
                unit: NEWER.into(),
                final_expiry: Some(1_800_000_000),
            },
        ],
        newest: NEWER.into(),
    };
    let gate_specs = [
        ("spawn", 10u64),
        ("court.jade", 50),
        ("court.crimson", 200),
        ("play.gacha", 5),
        ("play.bell", 3),
    ];
    let mut by_gate: HashMap<String, HashMap<String, Arc<ChargeMiddlewareState<MockRedeemer>>>> =
        HashMap::new();
    for (gate, amount) in gate_specs {
        let mut per_unit = HashMap::new();
        for unit in [OLDER, NEWER] {
            per_unit.insert(
                unit.to_string(),
                Arc::new(ChargeMiddlewareState::new(
                    requirement(unit, amount, gate),
                    MockRedeemer::new(),
                )),
            );
        }
        by_gate.insert(gate.to_string(), per_unit);
    }
    MultiUnitGates::from_states(valid, by_gate)
}

fn test_app() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let vault_path = dir.path().join("vault.json");
    std::fs::write(&vault_path, "{\"chest.jade\":[\"cashuBprize\"]}").unwrap();
    let sink = RevenueSink::open(dir.path().join("revenue.jsonl")).unwrap();
    let config = GameConfig {
        mint_url: MINT.into(),
        unit: NEWER.into(),
        accepted_units: vec![OLDER.into(), NEWER.into()],
        prices: [("spawn".to_string(), 10u64)].into_iter().collect(),
        mode: Mode::Live,
    };
    let app = Game::with_sink(
        default_world(10, 50, 200),
        config,
        Vault::new(vault_path),
        Some(sink),
        DEFAULT_GACHA_N,
    );
    (dir, app)
}

fn fake_session(app: &AppState) -> (String, tokio::sync::mpsc::Receiver<ServerMsg>) {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let (id, _hello) = app.connect(tx);
    (id, rx)
}

async fn post(
    router: &axum::Router,
    path: &str,
    session: Option<&str>,
    authorization: Option<&str>,
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::builder().method("POST").uri(path);
    if let Some(s) = session {
        req = req.header(SESSION_HEADER, s);
    }
    if let Some(a) = authorization {
        req = req.header(http::header::AUTHORIZATION, a);
    }
    let resp = router
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, headers, String::from_utf8_lossy(&body).to_string())
}

fn challenge_of(headers: &http::HeaderMap) -> PaymentParams {
    let www = headers
        .get(http::header::WWW_AUTHENTICATE)
        .expect("402 carries WWW-Authenticate")
        .to_str()
        .unwrap();
    parse_payment_params(www).expect("challenge parses")
}

/// The unit advertised inside a challenge's creqA request object.
fn challenge_unit(params: &PaymentParams) -> String {
    decode_charge_request(&params.request)
        .expect("request decodes")
        .unit
        .to_string()
}

fn credential_for(params: &PaymentParams, token: &str) -> String {
    let creds = PaymentCredentials {
        challenge: EchoedChallenge {
            id: params.id.clone(),
            realm: params.realm.clone(),
            method: params.method.clone(),
            intent: params.intent.clone(),
            request: params.request.clone(),
            digest: params.digest.clone(),
            opaque: params.opaque.clone(),
            expires: params.expires.clone(),
            description: params.description.clone(),
        },
        payload: CashuPayload {
            token: token.to_string(),
        },
        source: None,
    };
    format!("Payment {}", encode_payment_credentials(&creds))
}

// ---- the tests ---------------------------------------------------------------

#[tokio::test]
async fn declaring_the_newest_unit_challenges_in_it() {
    let (_dir, app) = test_app();
    let router = gated_router_multi(app.clone(), multi_gates());
    let (session, _rx) = fake_session(&app);
    let (status, headers, _b) =
        post(&router, &format!("/spawn?unit={NEWER}"), Some(&session), None).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(challenge_unit(&challenge_of(&headers)), NEWER);
}

#[tokio::test]
async fn declaring_no_unit_falls_back_to_newest() {
    // gudnuf's fresh-player path: a client that does not send ?unit= is
    // challenged in the advertised (newest) unit.
    let (_dir, app) = test_app();
    let router = gated_router_multi(app.clone(), multi_gates());
    let (session, _rx) = fake_session(&app);
    let (status, headers, _b) = post(&router, "/spawn", Some(&session), None).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(
        challenge_unit(&challenge_of(&headers)),
        NEWER,
        "no declared unit → the newest (mint-into) unit"
    );
}

#[tokio::test]
async fn declaring_an_older_but_valid_unit_challenges_in_that_older_unit() {
    // THE multi-unit-accept guarantee: a returning player on the older (still
    // valid) unit is challenged IN THAT unit, not forced onto the newest.
    let (_dir, app) = test_app();
    let router = gated_router_multi(app.clone(), multi_gates());
    let (session, _rx) = fake_session(&app);
    let (status, headers, _b) =
        post(&router, &format!("/spawn?unit={OLDER}"), Some(&session), None).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(
        challenge_unit(&challenge_of(&headers)),
        OLDER,
        "the older-but-valid unit is honored"
    );
}

#[tokio::test]
async fn paying_in_an_older_but_valid_unit_succeeds() {
    // The full dance in the older unit: bare → 402 (older), faithful echo + a
    // sufficient token → 200, entitlement granted. Proves the dispatch delegates
    // to the real require_charge with the older unit's state.
    let (_dir, app) = test_app();
    let router = gated_router_multi(app.clone(), multi_gates());
    let (session, _rx) = fake_session(&app);
    let path = format!("/spawn?unit={OLDER}");

    let (_s, headers, _b) = post(&router, &path, Some(&session), None).await;
    let params = challenge_of(&headers);
    assert_eq!(challenge_unit(&params), OLDER);

    let auth = credential_for(&params, "cashuBmock:10");
    let (status, headers, body) = post(&router, &path, Some(&session), Some(&auth)).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(headers.get("payment-receipt").is_some(), "200 carries the receipt");
    assert!(app.is_entitled(&session, "spawn"));
}

#[tokio::test]
async fn declaring_an_expired_unit_is_unit_retired_409() {
    // A held unit no longer in the valid set → a clear 409 telling the player to
    // mint the current unit, BEFORE any challenge/swap.
    let (_dir, app) = test_app();
    let router = gated_router_multi(app.clone(), multi_gates());
    let (session, _rx) = fake_session(&app);
    let (status, _headers, body) =
        post(&router, &format!("/spawn?unit={GONE}"), Some(&session), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let problem: serde_json::Value = serde_json::from_str(&body).expect("problem+json");
    assert_eq!(problem["title"], "unit-retired");
    assert_eq!(problem["currentUnit"], NEWER);
    assert_eq!(
        problem["acceptedUnits"],
        serde_json::json!([OLDER, NEWER]),
        "the 409 names what IS accepted"
    );
    // No challenge was issued (we did not waste a swap on a dead unit).
    assert!(!app.is_entitled(&session, "spawn"));
}

#[tokio::test]
async fn unit_can_also_be_declared_via_header() {
    // Header-capable clients may use x-bazaar-unit instead of ?unit=.
    let (_dir, app) = test_app();
    let router = gated_router_multi(app.clone(), multi_gates());
    let (session, _rx) = fake_session(&app);
    let req = Request::builder()
        .method("POST")
        .uri("/spawn")
        .header(SESSION_HEADER, &session)
        .header("x-bazaar-unit", OLDER)
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
    let params = challenge_of(resp.headers());
    assert_eq!(challenge_unit(&params), OLDER, "header-declared unit honored");
}
