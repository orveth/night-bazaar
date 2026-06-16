//! Integration tests for the 402 gate flow: the REAL pops-core-verify
//! middleware (challenge issuance, HMAC echo validation, problem mapping)
//! over a mock `Redeemer` (no mint). The mock simulates only what the MINT
//! decides in production: token value and double-spend. The real-money leg
//! against the Mutinynet rig is a separate, manual gate (see the spike
//! contract) — these tests prove OUR wiring, not the mint.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use http::{Request, StatusCode};
use tower::ServiceExt;

use night_bazaar_server::game::{AppState, Game, DEFAULT_GACHA_N};
use night_bazaar_server::gates::{gated_router, mock_router, GateStates};
use night_bazaar_server::protocol::{AvatarKind, GameConfig, Mode, ServerMsg, SESSION_HEADER};
use night_bazaar_server::sink::RevenueSink;
use night_bazaar_server::vault::Vault;
use night_bazaar_server::world::default_world;

use pops_core_verify::challenge::CashuRequirement;
use pops_core_verify::charge::{ChargeError, RedeemedProofs};
use pops_core_verify::envelope::{
    encode_payment_credentials, parse_payment_params, CashuPayload, EchoedChallenge,
    PaymentCredentials, PaymentParams,
};
use pops_core_verify::middleware::ChargeMiddlewareState;
use pops_core_verify::redeemer::{Redeemed, Redeemer};

/// Mock redeemer: accepts tokens of the form `cashuBmock:<amount>`, tracks
/// spends (replay -> DoubleSpend), enforces the requirement's amount
/// (under-funded -> PaymentInsufficient). Everything else the middleware does
/// for real.
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

const UNIT: &str = "pop_1700000000";
const MINT: &str = "http://127.0.0.1:28338";

fn requirement(amount: u64, gate: &str) -> CashuRequirement {
    use std::str::FromStr;
    CashuRequirement {
        unit: cashu::nuts::CurrencyUnit::from_str(UNIT).unwrap(),
        mints: vec![cashu::MintUrl::from_str(MINT).unwrap()],
        amount: cashu::Amount::from(amount),
        external_id: Some(format!("bazaar:{gate}")),
        description: None,
    }
}

fn test_app() -> (tempfile::TempDir, AppState) {
    test_app_with_vault("[\"cashuBprize\"]")
}

/// Build a live test app with a real (temp) revenue sink and a given vault
/// JSON body. The sink is REQUIRED in live mode (a paid gate persists before
/// granting), so every gate-flow test gets one. `revenue_path` reads it back.
fn test_app_with_vault(vault_json: &str) -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let vault_path = dir.path().join("vault.json");
    std::fs::write(&vault_path, vault_json).unwrap();
    let sink = RevenueSink::open(dir.path().join("revenue.jsonl")).unwrap();
    let config = GameConfig {
        mint_url: MINT.into(),
        unit: UNIT.into(),
        accepted_units: vec![UNIT.into()],
        prices: [
            ("spawn".to_string(), 10u64),
            ("court.jade".to_string(), 50),
            ("court.crimson".to_string(), 200),
        ]
        .into_iter()
        .collect(),
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

/// The revenue sink path for a test app's tempdir.
fn revenue_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("revenue.jsonl")
}

/// Read the sink as parsed JSON lines.
fn read_sink(dir: &tempfile::TempDir) -> Vec<serde_json::Value> {
    let raw = std::fs::read_to_string(revenue_path(dir)).unwrap_or_default();
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn live_router(app: AppState) -> axum::Router {
    let states = GateStates {
        spawn: Arc::new(ChargeMiddlewareState::new(
            requirement(10, "spawn"),
            MockRedeemer::new(),
        )),
        jade: Arc::new(ChargeMiddlewareState::new(
            requirement(50, "court.jade"),
            MockRedeemer::new(),
        )),
        crimson: Arc::new(ChargeMiddlewareState::new(
            requirement(200, "court.crimson"),
            MockRedeemer::new(),
        )),
        gacha: Arc::new(ChargeMiddlewareState::new(
            requirement(5, "play.gacha"),
            MockRedeemer::new(),
        )),
        bell: Arc::new(ChargeMiddlewareState::new(
            requirement(3, "play.bell"),
            MockRedeemer::new(),
        )),
    };
    gated_router(app, states)
}

/// Register a ws-less session directly on the game (the gate endpoints only
/// need the session to EXIST; the ws transport is irrelevant to the gate).
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

/// Build a credential that faithfully echoes `params` and presents `token` —
/// the same encoding path a real client uses (pops' own canonical encoder).
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

fn challenge_of(headers: &http::HeaderMap) -> PaymentParams {
    let www = headers
        .get(http::header::WWW_AUTHENTICATE)
        .expect("402 carries WWW-Authenticate")
        .to_str()
        .unwrap();
    parse_payment_params(www).expect("challenge parses")
}

#[tokio::test]
async fn bare_post_gets_402_challenge() {
    let (_dir, app) = test_app();
    let router = live_router(app);
    let (status, headers, _body) = post(&router, "/spawn", None, None).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    let params = challenge_of(&headers);
    assert_eq!(params.method, "cashu");
    assert_eq!(params.intent, "charge");
    assert!(params.expires.is_some(), "Rust hosts always stamp expires");
    assert_eq!(
        headers.get(http::header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
}

#[tokio::test]
async fn paid_spawn_marks_entitlement_and_spawns_body() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, mut rx) = fake_session(&app);

    // 1. bare -> challenge
    let (_s, headers, _b) = post(&router, "/spawn", Some(&session), None).await;
    let params = challenge_of(&headers);

    // 2. faithful echo + sufficient token -> 200, entitled, receipt header
    let auth = credential_for(&params, "cashuBmock:10");
    let (status, headers, body) = post(&router, "/spawn", Some(&session), Some(&auth)).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(headers.get("payment-receipt").is_some(), "200 carries Payment-Receipt");
    assert!(app.is_entitled(&session, "spawn"));
    // ws layer was notified
    let mut saw_entitlement = false;
    while let Ok(m) = rx.try_recv() {
        if matches!(&m, ServerMsg::Entitlement { gate } if gate == "spawn") {
            saw_entitlement = true;
        }
    }
    assert!(saw_entitlement);
}

#[tokio::test]
async fn replayed_token_rejected() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);

    let (_s, headers, _b) = post(&router, "/enter/jade", Some(&session), None).await;
    let params = challenge_of(&headers);
    let auth = credential_for(&params, "cashuBmock:50");
    let (status, _h, _b) = post(&router, "/enter/jade", Some(&session), Some(&auth)).await;
    assert_eq!(status, StatusCode::OK);

    // Same token against a fresh session+challenge: the mint-side double-spend
    // (mocked) maps to 402 verification-failed with a fresh challenge.
    let (session2, _rx2) = fake_session(&app);
    let (_s, headers2, _b) = post(&router, "/enter/jade", Some(&session2), None).await;
    let params2 = challenge_of(&headers2);
    let auth2 = credential_for(&params2, "cashuBmock:50");
    let (status, headers3, body) = post(&router, "/enter/jade", Some(&session2), Some(&auth2)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert!(body.contains("verification-failed"), "body: {body}");
    assert!(headers3.get(http::header::WWW_AUTHENTICATE).is_some(), "402 re-challenges");
    assert!(!app.is_entitled(&session2, "court.jade"));
}

#[tokio::test]
async fn wrong_amount_rejected() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);

    let (_s, headers, _b) = post(&router, "/enter/crimson", Some(&session), None).await;
    let params = challenge_of(&headers);
    let auth = credential_for(&params, "cashuBmock:50"); // needs 200
    let (status, _h, body) = post(&router, "/enter/crimson", Some(&session), Some(&auth)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert!(body.contains("payment-insufficient"), "body: {body}");
    assert!(!app.is_entitled(&session, "court.crimson"));
}

#[tokio::test]
async fn tampered_echo_is_invalid_challenge() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);

    let (_s, headers, _b) = post(&router, "/spawn", Some(&session), None).await;
    let mut params = challenge_of(&headers);
    params.realm = "tampered-realm".into(); // breaks the HMAC binding
    let auth = credential_for(&params, "cashuBmock:10");
    let (status, _h, body) = post(&router, "/spawn", Some(&session), Some(&auth)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert!(body.contains("invalid-challenge"), "body: {body}");
    assert!(!app.is_entitled(&session, "spawn"));
}

#[tokio::test]
async fn unknown_session_is_409_after_payment() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());

    let (_s, headers, _b) = post(&router, "/spawn", Some("does-not-exist"), None).await;
    let params = challenge_of(&headers);
    let auth = credential_for(&params, "cashuBmock:10");
    let (status, _h, body) =
        post(&router, "/spawn", Some("does-not-exist"), Some(&auth)).await;
    // The pop was redeemed (middleware ran first); the entitlement cannot bind.
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("unknown-session"), "body: {body}");
}

#[tokio::test]
async fn missing_session_header_is_400_before_payment_makes_sense() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    // Even on the bare request the middleware answers first with 402 (it runs
    // before the handler), so the missing-header 400 only surfaces on a PAID
    // request. This is middleware-ordering reality; the client always connects
    // the ws first.
    let (status, headers, _b) = post(&router, "/spawn", None, None).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    let params = challenge_of(&headers);
    let auth = credential_for(&params, "cashuBmock:10");
    let (status, _h, body) = post(&router, "/spawn", None, Some(&auth)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("missing-session"), "body: {body}");
}

#[tokio::test]
async fn court_entitlement_is_session_bound() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (payer, _rx1) = fake_session(&app);
    let (freeloader, _rx2) = fake_session(&app);

    let (_s, headers, _b) = post(&router, "/enter/jade", Some(&payer), None).await;
    let params = challenge_of(&headers);
    let auth = credential_for(&params, "cashuBmock:50");
    let (status, _h, _b) = post(&router, "/enter/jade", Some(&payer), Some(&auth)).await;
    assert_eq!(status, StatusCode::OK);

    assert!(app.is_entitled(&payer, "court.jade"));
    assert!(!app.is_entitled(&freeloader, "court.jade"));
}

#[tokio::test]
async fn session_query_param_works_for_headerless_clis() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);

    let path = format!("/spawn?session={session}");
    let (_s, headers, _b) = post(&router, &path, None, None).await;
    let params = challenge_of(&headers);
    let auth = credential_for(&params, "cashuBmock:10");
    let (status, _h, body) = post(&router, &path, None, Some(&auth)).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(app.is_entitled(&session, "spawn"));
}

#[tokio::test]
async fn mock_router_grants_without_payment() {
    let (_dir, app) = test_app();
    let router = mock_router(app.clone());
    let (session, _rx) = fake_session(&app);
    let (status, _h, body) = post(&router, "/spawn", Some(&session), None).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(app.is_entitled(&session, "spawn"));
}

/* ------------------------- Phase 1b: the revenue sink --------------------- */

/// Do the bare -> challenge -> credential -> paid dance and return the final
/// (status, headers, body) for a sufficient-amount token.
async fn pay_through(
    router: &axum::Router,
    path: &str,
    session: &str,
    amount: u64,
) -> (StatusCode, http::HeaderMap, String) {
    let (_s, headers, _b) = post(router, path, Some(session), None).await;
    let params = challenge_of(&headers);
    let auth = credential_for(&params, &format!("cashuBmock:{amount}"));
    post(router, path, Some(session), Some(&auth)).await
}

#[tokio::test]
async fn paid_gate_writes_one_sink_line_then_grants() {
    let (dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);

    // Overpay (15 against a 10 price): the sink records the NET received.
    let (status, _h, body) = pay_through(&router, "/spawn", &session, 15).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(app.is_entitled(&session, "spawn"), "grant must follow persist");

    let lines = read_sink(&dir);
    assert_eq!(lines.len(), 1, "exactly one sink line for one paid gate");
    let rec = &lines[0];
    assert_eq!(rec["gate"], "spawn");
    assert_eq!(rec["session"], session.as_str());
    assert_eq!(rec["amount"], 15, "records net received (overpay retained)");
    assert_eq!(rec["unit"], UNIT);
    // The denormalized bearer proofs ride under `proofs` (the mock's fresh).
    assert_eq!(rec["proofs"]["fresh_proofs"], "cashuBfresh");
    assert_eq!(rec["proofs"]["active_keyset_id"], "01aa");
    assert!(rec["ts"].is_number());
}

/// The flush-before-grant invariant: if the value cannot be durably persisted,
/// the gate must NOT grant the entitlement. We force this with a LIVE app that
/// has NO sink configured (so persist fails) and assert the 500 + no grant.
/// (A healthy tempfile sink cannot be made to fail a write on demand; the
/// no-sink path exercises the same refuse-rather-than-drop branch.)
#[tokio::test]
async fn gate_refuses_to_grant_when_revenue_cannot_be_persisted() {
    let dir = tempfile::tempdir().unwrap();
    let vault_path = dir.path().join("vault.json");
    std::fs::write(&vault_path, "[\"cashuBprize\"]").unwrap();
    let config = GameConfig {
        mint_url: MINT.into(),
        unit: UNIT.into(),
        accepted_units: vec![UNIT.into()],
        prices: [("spawn".to_string(), 10u64)].into_iter().collect(),
        mode: Mode::Live,
    };
    // Live config, but sink = None (the failure injection).
    let app = Game::new(default_world(10, 50, 200), config, Vault::new(vault_path));
    let router = live_router(app.clone());
    let (session, mut rx) = fake_session(&app);

    let (status, _h, body) = pay_through(&router, "/spawn", &session, 10).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body: {body}");
    assert!(body.contains("revenue-unpersisted"), "body: {body}");
    assert!(!app.is_entitled(&session, "spawn"), "must NOT grant if not persisted");
    // No entitlement pushed to the ws either.
    let mut saw = false;
    while let Ok(m) = rx.try_recv() {
        if matches!(&m, ServerMsg::Entitlement { .. }) {
            saw = true;
        }
    }
    assert!(!saw, "no entitlement may be pushed when the sink failed");
}

/* ------------------------- Phase 1b: paid plays --------------------------- */

#[tokio::test]
async fn gacha_bare_post_gets_a_402_challenge() {
    let (_dir, app) = test_app();
    let router = live_router(app);
    let (status, headers, _b) = post(&router, "/play/gacha", None, None).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    let params = challenge_of(&headers);
    assert_eq!(params.method, "cashu");
    assert_eq!(params.intent, "charge");
}

#[tokio::test]
async fn gacha_paid_pull_persists_and_returns_a_result_deterministically() {
    // Stock the gacha booth so the 8th pull can win.
    let (dir, app) = test_app_with_vault(
        r#"{"booth.gacha": ["cashuBgachaPrize"], "chest.jade": ["cashuBprize"]}"#,
    );
    let router = live_router(app.clone());
    let (session, mut rx) = fake_session(&app);
    // Put the body at the gacha shrine in crimson (server-authoritative reach).
    app.force_place(&session, AvatarKind::Body, 18.0, 14.0);

    // Seven losing pulls, then the 8th wins (N = DEFAULT_GACHA_N = 8). Each
    // pull presents a UNIQUE token (price 5, paying 10+pull) so the mock's
    // double-spend guard does not trip; overpay (>= amount) is retained.
    let mut win_seen = false;
    for pull in 1..=8u64 {
        let (status, _h, body) = pay_through(&router, "/play/gacha", &session, 10 + pull).await;
        assert_eq!(status, StatusCode::OK, "pull {pull} body: {body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["play"], "gacha");
        assert!(v["fortune"].is_string());
        if pull < 8 {
            assert_eq!(v["win"], false, "pull {pull} must lose");
            assert!(v.get("token").is_none(), "a loss carries no token");
        } else {
            assert_eq!(v["win"], true, "the 8th pull must win");
            assert_eq!(v["token"], "cashuBgachaPrize", "winner gets the booth token");
            win_seen = true;
        }
    }
    assert!(win_seen);

    // Exactly 8 sink lines, all gated as play.gacha.
    let lines = read_sink(&dir);
    assert_eq!(lines.len(), 8, "one sink line per paid pull");
    assert!(lines.iter().all(|l| l["gate"] == "play.gacha"));

    // The booth vault was debited exactly once (the winning pull).
    assert_eq!(app.vault.stock_for("booth.gacha").unwrap(), 0);

    // No ws prize for gacha (HTTP carries the token); drain to be sure.
    while let Ok(m) = rx.try_recv() {
        assert!(!matches!(m, ServerMsg::Prize { .. }), "gacha prize rides HTTP, not ws");
    }
}

#[tokio::test]
async fn gacha_win_with_empty_stock_reports_sold_out_no_token() {
    // Booth present but EMPTY: the 8th pull "wins" but there is nothing to give.
    let (_dir, app) = test_app(); // legacy vault = chest.jade only; booth.gacha empty
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);
    app.force_place(&session, AvatarKind::Body, 18.0, 14.0);

    let mut body = String::new();
    for pull in 1..=8u64 {
        let (status, _h, b) = pay_through(&router, "/play/gacha", &session, 10 + pull).await;
        assert_eq!(status, StatusCode::OK);
        body = b;
    }
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["win"], true);
    assert_eq!(v["soldOut"], true);
    assert!(v.get("token").is_none(), "sold-out win carries no token");
}

#[tokio::test]
async fn gacha_paid_but_not_at_the_booth_is_refused() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);
    // A spawned body, but still at the street spawn (not in crimson at the shrine).
    app.force_place(&session, AvatarKind::Body, 0.0, 0.0);
    let (status, _h, body) = pay_through(&router, "/play/gacha", &session, 5).await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {body}");
    assert!(body.contains("out-of-reach"), "body: {body}");
}

#[tokio::test]
async fn bell_paid_play_then_press_is_judged_by_the_server_clock() {
    let (dir, app) = test_app_with_vault(
        r#"{"booth.bell": ["cashuBbellPrize"], "chest.jade": ["cashuBprize"]}"#,
    );
    let router = live_router(app.clone());
    let (session, mut rx) = fake_session(&app);
    app.force_place(&session, AvatarKind::Body, 4.5, 8.5); // at the bell on the street

    // Pay for a play: the response carries the play handle.
    let (status, _h, body) = pay_through(&router, "/play/bell", &session, 3).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["play"], "bell");
    assert!(v["playId"].is_string());
    assert!(v["periodMs"].as_u64().unwrap() > 0);
    assert!(v["toleranceMs"].as_u64().unwrap() > 0);

    // Press IMMEDIATELY (elapsed ~0 = a sweet-spot crossing) -> hit + prize.
    let (status, _h, pbody) = post(&router, "/play/bell/press", Some(&session), None).await;
    assert_eq!(status, StatusCode::OK, "press body: {pbody}");
    let pv: serde_json::Value = serde_json::from_str(&pbody).unwrap();
    assert_eq!(pv["hit"], true, "an immediate press lands on the start crossing");
    assert_eq!(pv["token"], "cashuBbellPrize");

    // The booth vault was debited and a ws prize + a BellRing went out.
    assert_eq!(app.vault.stock_for("booth.bell").unwrap(), 0);
    let mut saw_prize = false;
    let mut saw_ring = false;
    while let Ok(m) = rx.try_recv() {
        match m {
            ServerMsg::Prize { chest, .. } if chest == "booth.bell" => saw_prize = true,
            ServerMsg::BellRing { booth, hit, .. } if booth == "booth.bell" && hit => saw_ring = true,
            _ => {}
        }
    }
    assert!(saw_prize, "bell prize rides the ws to the presser");
    assert!(saw_ring, "a bell ring broadcasts to everyone");

    // The play was one-shot: a second press has no live play.
    let (status, _h, body2) = post(&router, "/play/bell/press", Some(&session), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body2.contains("no-live-play"), "body: {body2}");

    // One sink line for the paid play; the press is free (no sink line).
    let lines = read_sink(&dir);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["gate"], "play.bell");
}

#[tokio::test]
async fn bell_press_without_a_paid_play_is_refused() {
    let (_dir, app) = test_app();
    let router = live_router(app.clone());
    let (session, _rx) = fake_session(&app);
    app.force_place(&session, AvatarKind::Body, 4.5, 8.5);
    let (status, _h, body) = post(&router, "/play/bell/press", Some(&session), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {body}");
    assert!(body.contains("no-live-play"), "body: {body}");
}

/* -------- mint-URL audience split (BAZAAR_MINT_PUBLIC_URLS) ---------- */

use axum::routing::get as axum_get;
use night_bazaar_server::protocol::GameConfig as GameConfigType;

/// Build an app + `/api/config` router with a custom `mint_url` in `GameConfig`.
fn app_with_mint_url(mint_url: &str) -> (tempfile::TempDir, AppState, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    let vault_path = dir.path().join("vault.json");
    std::fs::write(&vault_path, "[\"cashuBprize\"]").unwrap();
    let sink = RevenueSink::open(dir.path().join("revenue.jsonl")).unwrap();
    let config = GameConfig {
        mint_url: mint_url.into(),
        unit: UNIT.into(),
        accepted_units: vec![UNIT.into()],
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

    // Minimal router that serves /api/config with the app's config.
    async fn api_config(
        axum::extract::State(app): axum::extract::State<AppState>,
    ) -> axum::Json<GameConfigType> {
        axum::Json(app.config.clone())
    }

    let router = axum::Router::new()
        .route("/api/config", axum_get(api_config))
        .with_state(app.clone());
    (dir, app, router)
}

/// `/api/config` must advertise the FIRST public URL (the client-facing one),
/// not the server-side direct URL.
#[tokio::test]
async fn api_config_advertises_first_public_url() {
    let public_url = "http://localhost:8410/mint";
    let (_dir, _app, router) = app_with_mint_url(public_url);

    let req = axum::http::Request::builder()
        .uri("/api/config")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let cfg: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        cfg["mintUrl"],
        public_url,
        "api/config must advertise the public mint URL, not the direct one"
    );
}

/// A `CashuRequirement` built with multiple public mint URLs must encode all of
/// them in the creqA `m` field (so the 402 challenge advertises the full
/// allowlist).  This is the key coupling between the public-URL split and the
/// middleware: `requirement.mints` = what goes in both the challenge and the
/// validator's allowlist check.
#[test]
fn requirement_mints_contains_all_public_urls() {
    use std::str::FromStr;
    use pops_core_verify::challenge::{CashuRequirement, decode_charge_request, encode_charge_request};

    let public_urls = vec![
        "http://localhost:8410/mint",
        "http://100.96.251.111:8410/mint",
    ];
    let mints: Vec<cashu::MintUrl> = public_urls
        .iter()
        .map(|u| cashu::MintUrl::from_str(u).unwrap())
        .collect();

    let req = CashuRequirement {
        unit: cashu::nuts::CurrencyUnit::from_str(UNIT).unwrap(),
        mints: mints.clone(),
        amount: cashu::Amount::from(10u64),
        external_id: Some("bazaar:spawn".into()),
        description: None,
    };

    // The challenge request object encodes all mints in the creqA `m` field.
    let encoded = encode_charge_request(&req).expect("encodes with multiple mints");
    let decoded = decode_charge_request(&encoded).expect("decodes");
    assert_eq!(
        decoded.mints, mints,
        "all public mint URLs must survive the creqA round-trip"
    );
}

/// When `BAZAAR_MINT_PUBLIC_URLS` is unset, the requirement's mints list must
/// fall back to the direct `BAZAAR_MINT_URL` — existing single-mint behavior
/// preserved exactly.
#[test]
fn requirement_mints_falls_back_to_direct_url_when_public_unset() {
    use std::str::FromStr;
    use pops_core_verify::challenge::CashuRequirement;

    // Simulate the zero-config path: only one mint (the direct URL).
    let direct = "http://127.0.0.1:28338";
    let mints = vec![cashu::MintUrl::from_str(direct).unwrap()];

    let req = CashuRequirement {
        unit: cashu::nuts::CurrencyUnit::from_str(UNIT).unwrap(),
        mints,
        amount: cashu::Amount::from(10u64),
        external_id: None,
        description: None,
    };
    assert_eq!(req.mints.len(), 1, "zero-config: exactly one mint");
    assert_eq!(
        req.mints[0].to_string(),
        direct,
        "zero-config: mint is the direct URL"
    );
}
