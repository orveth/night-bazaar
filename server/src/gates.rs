//! The 402 gates: `POST /spawn` and `POST /enter/:court` behind the
//! pops-core-verify `require_charge` middleware.
//!
//! Wiring per the pops repo's `skills/gate-a-service.md` (mode 2, in-process
//! axum): one `ChargeMiddlewareState` per price point, registered with
//! `from_fn_with_state(state, require_charge)`. The middleware answers a bare
//! POST with the 402 + `WWW-Authenticate: Payment` challenge, verifies and
//! REDEEMS the credential on retry, and only then lets the handler run; the
//! handler's only job is the game-side effect: mark the (session, gate)
//! entitlement and let the ws layer open the door.
//!
//! Generic over `C: Redeemer` so the integration tests drive the REAL
//! middleware (challenge issuance + HMAC echo validation + problem mapping)
//! with a mock redeemer, no mint required.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use http::StatusCode;
use pops_core_verify::middleware::{require_charge, ChargeMiddlewareState};
use pops_core_verify::redeemer::{Redeemed, Redeemer};
use serde_json::json;
use tracing::{error, info};

use crate::game::{AppState, GrantError};
use crate::multiunit::{require_charge_multi, GateDispatch, MultiUnitGates};
use crate::protocol::SESSION_HEADER;

/// The three per-gate middleware states (different prices -> different
/// challenges). `None` builds the mock router (BAZAAR_MODE=mock): same
/// handlers, NO payment layer (dev/smoke only, loudly logged at boot).
pub struct GateStates<C: Redeemer + Send + Sync + 'static> {
    pub spawn: Arc<ChargeMiddlewareState<C>>,
    pub jade: Arc<ChargeMiddlewareState<C>>,
    pub crimson: Arc<ChargeMiddlewareState<C>>,
    /// Paid-play middleware (Phase 1b): a per-play charge, same wire as doors.
    pub gacha: Arc<ChargeMiddlewareState<C>>,
    pub bell: Arc<ChargeMiddlewareState<C>>,
}

/// Build the gated routes. `/enter/:court` is served as the two concrete
/// courts (`/enter/jade`, `/enter/crimson`) because each carries its own
/// price and therefore its own middleware state; unknown courts 404.
pub fn gated_router<C: Redeemer + Send + Sync + 'static>(
    app: AppState,
    states: GateStates<C>,
) -> Router {
    let gate = |path: &str, gate_id: &'static str, mw: Arc<ChargeMiddlewareState<C>>| {
        Router::new()
            .route(
                path,
                post(
                    move |state: State<AppState>,
                          query: Query<HashMap<String, String>>,
                          headers: HeaderMap,
                          redeemed: Option<Extension<Redeemed>>| {
                        gate_paid(state, query, headers, redeemed, gate_id)
                    },
                ),
            )
            .layer(from_fn_with_state(mw, require_charge::<C>))
            .with_state(app.clone())
    };

    // Paid-play routes: same middleware, but the handler returns the play
    // RESULT (the paid request IS one play) instead of granting an entitlement.
    let play = |path: &str,
                booth_id: &'static str,
                kind: PlayKind,
                mw: Arc<ChargeMiddlewareState<C>>| {
        Router::new()
            .route(
                path,
                post(
                    move |state: State<AppState>,
                          query: Query<HashMap<String, String>>,
                          headers: HeaderMap,
                          redeemed: Option<Extension<Redeemed>>| {
                        play_paid(state, query, headers, redeemed, booth_id, kind)
                    },
                ),
            )
            .layer(from_fn_with_state(mw, require_charge::<C>))
            .with_state(app.clone())
    };

    gate("/spawn", "spawn", states.spawn)
        .merge(gate("/enter/jade", "court.jade", states.jade))
        .merge(gate("/enter/crimson", "court.crimson", states.crimson))
        .merge(play("/play/gacha", "booth.gacha", PlayKind::Gacha, states.gacha))
        .merge(play("/play/bell", "booth.bell", PlayKind::Bell, states.bell))
        // The bell PRESS is free + session-checked (no middleware, no payment):
        // the play was already paid; the press is judged by the server clock.
        .merge(
            Router::new()
                .route("/play/bell/press", post(bell_press))
                .with_state(app.clone()),
        )
}

/// Build the gated routes with MULTI-UNIT accept. Identical to
/// [`gated_router`] except each gate is layered with [`require_charge_multi`]
/// (the unit-dispatch middleware) over a shared [`MultiUnitGates`] registry
/// instead of a single fixed-unit [`ChargeMiddlewareState`]. The handlers are
/// unchanged. This is the live router; the rotation/overlap fix lives entirely
/// in the dispatch layer (the verifier is untouched; see
/// [`crate::multiunit`]).
pub fn gated_router_multi<C: Redeemer + Send + Sync + 'static>(
    app: AppState,
    gates: Arc<MultiUnitGates<C>>,
) -> Router {
    let gate = |path: &str, gate_id: &'static str| {
        let dispatch = GateDispatch {
            gates: gates.clone(),
            gate_id: gate_id.to_string(),
        };
        Router::new()
            .route(
                path,
                post(
                    move |state: State<AppState>,
                          query: Query<HashMap<String, String>>,
                          headers: HeaderMap,
                          redeemed: Option<Extension<Redeemed>>| {
                        gate_paid(state, query, headers, redeemed, gate_id)
                    },
                ),
            )
            .layer(from_fn_with_state(dispatch, require_charge_multi::<C>))
            .with_state(app.clone())
    };

    let play = |path: &str, booth_id: &'static str, gate_id: &'static str, kind: PlayKind| {
        let dispatch = GateDispatch {
            gates: gates.clone(),
            gate_id: gate_id.to_string(),
        };
        Router::new()
            .route(
                path,
                post(
                    move |state: State<AppState>,
                          query: Query<HashMap<String, String>>,
                          headers: HeaderMap,
                          redeemed: Option<Extension<Redeemed>>| {
                        play_paid(state, query, headers, redeemed, booth_id, kind)
                    },
                ),
            )
            .layer(from_fn_with_state(dispatch, require_charge_multi::<C>))
            .with_state(app.clone())
    };

    gate("/spawn", "spawn")
        .merge(gate("/enter/jade", "court.jade"))
        .merge(gate("/enter/crimson", "court.crimson"))
        .merge(play("/play/gacha", "booth.gacha", "play.gacha", PlayKind::Gacha))
        .merge(play("/play/bell", "booth.bell", "play.bell", PlayKind::Bell))
        .merge(
            Router::new()
                .route("/play/bell/press", post(bell_press))
                .with_state(app.clone()),
        )
}

/// Which paid play a `/play/:kind` route drives.
#[derive(Debug, Clone, Copy)]
enum PlayKind {
    Gacha,
    Bell,
}

/// The free-gate router for BAZAAR_MODE=mock: identical paths + handlers,
/// no payment middleware. Never use outside dev/smoke.
pub fn mock_router(app: AppState) -> Router {
    let gate = |path: &str, gate_id: &'static str| {
        Router::new()
            .route(
                path,
                post(
                    move |state: State<AppState>,
                          query: Query<HashMap<String, String>>,
                          headers: HeaderMap| {
                        gate_paid(state, query, headers, None, gate_id)
                    },
                ),
            )
            .with_state(app.clone())
    };
    let play = |path: &str, booth_id: &'static str, kind: PlayKind| {
        Router::new()
            .route(
                path,
                post(
                    move |state: State<AppState>,
                          query: Query<HashMap<String, String>>,
                          headers: HeaderMap| {
                        play_paid(state, query, headers, None, booth_id, kind)
                    },
                ),
            )
            .with_state(app.clone())
    };
    gate("/spawn", "spawn")
        .merge(gate("/enter/jade", "court.jade"))
        .merge(gate("/enter/crimson", "court.crimson"))
        .merge(play("/play/gacha", "booth.gacha", PlayKind::Gacha))
        .merge(play("/play/bell", "booth.bell", PlayKind::Bell))
        .merge(
            Router::new()
                .route("/play/bell/press", post(bell_press))
                .with_state(app.clone()),
        )
}

/// Post-payment handler: bind the redeemed charge to the ws session named in
/// the `x-bazaar-session` header (primary) or a `?session=` query param (a
/// CLI affordance: `pop pay` cannot attach custom headers).
///
/// Runs AFTER `require_charge`, so the pop is already verified + redeemed
/// (value held). A missing/unknown session id can no longer refuse the
/// payment; it can only refuse the entitlement. The client guards by always
/// connecting the ws first. This mirrors the gateway's documented
/// paid-but-upstream-down v1 edge.
async fn gate_paid(
    State(app): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    redeemed: Option<Extension<Redeemed>>,
    gate_id: &'static str,
) -> Response {
    let session = match session_from(&headers, &query) {
        Some(s) => s,
        None => return missing_session(),
    };

    // The sink is a WALLET: persist the redeemed value BEFORE granting the
    // entitlement. A crash (or a refusal) between persist and grant must never
    // consume a pop with no durable record of the bearer proofs. Mock requests
    // carry no `Redeemed`, so there is nothing to persist.
    if let Some(Extension(r)) = redeemed.as_ref() {
        if let Err(e) = app.persist_revenue(gate_id, &session, r) {
            // Last-resort: name the lost token's RECEIPT hash (never the
            // proofs) and refuse the request. The pop was redeemed and is
            // retained as fresh proofs; an operator can recover from the mint
            // logs + this hash. We do NOT grant; the player can retry, and
            // the verifier's replay guard prevents a second charge.
            error!(
                %session,
                gate = gate_id,
                token_hash = %r.proofs.token_hash,
                "REVENUE SINK WRITE FAILED; value redeemed but not persisted: {e}"
            );
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "revenue-unpersisted",
                "the payment was redeemed but the server could not durably record it; \
                 it is retained — contact the operator with your receipt",
            );
        }
    }

    let paid = redeemed.as_ref().map(|Extension(r)| (r.amount, r.unit.clone()));
    match app.grant(&session, gate_id) {
        Ok(()) => {
            if let Some((amount, ref unit)) = paid {
                info!(%session, gate = gate_id, amount, %unit, "gate paid + persisted + entitlement granted");
            } else {
                info!(%session, gate = gate_id, "MOCK gate granted (no payment ran)");
            }
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "gate": gate_id,
                    "session": session,
                    "paid": paid.as_ref().map(|(a, u)| json!({"amount": a, "unit": u})),
                })),
            )
                .into_response()
        }
        Err(GrantError::UnknownSession) => problem(
            StatusCode::CONFLICT,
            "unknown-session",
            "no live ws session with that id; the payment (if any) was \
             redeemed and is retained — reconnect and pay against the live session",
        ),
    }
}

/// The ws session id from the `x-bazaar-session` header (primary) or a
/// `?session=` query param (a CLI affordance: `pop pay` cannot attach headers).
fn session_from(headers: &HeaderMap, query: &HashMap<String, String>) -> Option<String> {
    let from_header = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let from_query = query
        .get("session")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    from_header.or(from_query)
}

fn missing_session() -> Response {
    problem(
        StatusCode::BAD_REQUEST,
        "missing-session",
        &format!(
            "carry your ws session id in the {SESSION_HEADER} header \
             (or ?session= for header-less CLIs); connect the websocket \
             before paying"
        ),
    )
}

/// Paid-play handler (Phase 1b): the paid request IS one play. Runs AFTER
/// `require_charge`, so the pop is verified + redeemed. Persists the value to
/// the sink FIRST (sink-is-a-wallet), then runs the game-side effect and
/// returns the play RESULT in the 200 body. A play that cannot bind to a live
/// in-reach body is a paid-but-unfulfillable request (the pop is retained).
async fn play_paid(
    State(app): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    redeemed: Option<Extension<Redeemed>>,
    booth_id: &'static str,
    kind: PlayKind,
) -> Response {
    let session = match session_from(&headers, &query) {
        Some(s) => s,
        None => return missing_session(),
    };

    // Sink FIRST: persist the redeemed value before resolving the play. A play
    // result we return without having recorded the proofs is lost money.
    if let Some(Extension(r)) = redeemed.as_ref() {
        if let Err(e) = app.persist_revenue(&play_gate_id(kind), &session, r) {
            error!(
                %session,
                gate = %play_gate_id(kind),
                token_hash = %r.proofs.token_hash,
                "REVENUE SINK WRITE FAILED on a paid play; value redeemed, not persisted: {e}"
            );
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "revenue-unpersisted",
                "the play was paid but the server could not durably record it; \
                 it is retained — contact the operator with your receipt",
            );
        }
    }

    let paid = redeemed.as_ref().map(|Extension(r)| r.amount).unwrap_or(0);

    match kind {
        PlayKind::Gacha => match app.play_gacha(&session, booth_id) {
            Ok(o) => {
                let mut body = json!({
                    "booth": booth_id,
                    "play": "gacha",
                    "win": o.win,
                    "fortune": o.fortune,
                    "pity": o.pity,
                    "paid": paid,
                });
                if let Some(t) = o.token {
                    body["token"] = json!(t);
                }
                if o.sold_out {
                    body["soldOut"] = json!(true);
                }
                (StatusCode::OK, Json(body)).into_response()
            }
            Err(e) => play_error(e, "shrine"),
        },
        PlayKind::Bell => match app.play_bell_start(&session, booth_id) {
            Ok((play_id, period_ms, tolerance_ms, expires_in_ms)) => (
                StatusCode::OK,
                Json(json!({
                    "booth": booth_id,
                    "play": "bell",
                    "playId": play_id,
                    // A per-play visual seed for the pendulum's starting phase
                    // (client render only; the server judges by wall time).
                    "seed": play_seed(&play_id),
                    "periodMs": period_ms,
                    "toleranceMs": tolerance_ms,
                    "expiresInMs": expires_in_ms,
                    "paid": paid,
                })),
            )
                .into_response(),
            Err(e) => play_error(e, "bell"),
        },
    }
}

/// The free, session-checked bell PRESS endpoint. The play was already paid;
/// the server judges the timing against ITS clock and the play's start.
async fn bell_press(
    State(app): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let session = match session_from(&headers, &query) {
        Some(s) => s,
        None => return missing_session(),
    };
    match app.play_bell_press(&session) {
        Ok(o) => {
            let mut body = json!({
                "booth": "booth.bell",
                "play": "bell",
                "hit": o.hit,
                "offsetMs": o.offset_ms,
            });
            if let Some(t) = o.token {
                body["token"] = json!(t);
            }
            if o.sold_out {
                body["soldOut"] = json!(true);
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => play_error(e, "bell"),
    }
}

fn play_gate_id(kind: PlayKind) -> String {
    match kind {
        PlayKind::Gacha => "play.gacha".to_string(),
        PlayKind::Bell => "play.bell".to_string(),
    }
}

/// A deterministic per-play visual seed derived from the play id (no
/// randomness; the id is already unique per play). The seed only shapes the
/// client pendulum's starting phase (the server clock is authoritative).
fn play_seed(play_id: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in play_id.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

fn play_error(e: crate::game::PlayError, noun: &str) -> Response {
    use crate::game::PlayError::*;
    match e {
        UnknownSession => problem(
            StatusCode::CONFLICT,
            "unknown-session",
            "no live ws session with that id; the payment (if any) was redeemed \
             and is retained — reconnect and play against the live session",
        ),
        NotABody => problem(
            StatusCode::CONFLICT,
            "not-a-body",
            "buy a body before playing — the payment (if any) is retained",
        ),
        OutOfReach => problem(
            StatusCode::CONFLICT,
            "out-of-reach",
            &format!("stand at the {noun} to play — the payment (if any) is retained"),
        ),
        NoLivePlay => problem(
            StatusCode::CONFLICT,
            "no-live-play",
            "no live play for this session (it may have expired) — start a new one",
        ),
    }
}

fn problem(status: StatusCode, title: &str, detail: &str) -> Response {
    (
        status,
        [(http::header::CONTENT_TYPE, "application/problem+json")],
        Json(json!({
            "type": "about:blank",
            "title": title,
            "status": status.as_u16(),
            "detail": detail,
        })),
    )
        .into_response()
}
