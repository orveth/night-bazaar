//! Night Bazaar Phase-0 spike server: ONE axum app serving
//!   - the game websocket (`/ws`, server-authoritative positions),
//!   - the pops-gated endpoints (`POST /spawn`, `POST /enter/:court`),
//!   - the built client statics (`/`),
//!   - a small config/health surface (`/api/config`, `/healthz`).
//!
//! Run (from `night-bazaar/server`, cargo via the pops devshell):
//!   CARGO_NET_GIT_FETCH_WITH_CLI=true \
//!   nix develop /srv/forge/projects/pops -c cargo run --release

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{State, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use cashu::MintUrl;
use pops_core_verify::binding::BindingKey;
use std::str::FromStr;
use tower_http::services::ServeDir;
use tracing::{error, info, warn};

use night_bazaar_server::config::Config;
use night_bazaar_server::game::{self, AppState, Game};
use night_bazaar_server::gates;
use night_bazaar_server::multiunit::{GateSpec, MultiUnitGates};
use night_bazaar_server::protocol::{GameConfig, Mode};
use night_bazaar_server::proxy::{mint_proxy, MintProxyState};
use night_bazaar_server::sink::RevenueSink;
use night_bazaar_server::vault::Vault;
use night_bazaar_server::{mint, world};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,night_bazaar_server=debug".into()),
        )
        .init();

    let cfg = Config::from_env()?;
    info!(?cfg.bind, %cfg.mint_url, mode = ?cfg.mode, "night bazaar booting");

    // The VALID SET of pop_<ts> units is READ FROM THE MINT at boot, never
    // hardcoded (units rotate + overlap). The newest is the mint-into unit; the
    // whole set is accepted (multi-unit accept — see `multiunit`). Mock mode
    // skips the probe entirely.
    let valid_units = match cfg.mode {
        Mode::Live => {
            let valid = mint::fetch_valid_pop_units(
                &cfg.mint_url,
                Duration::from_secs(cfg.mint_timeout_secs),
            )
            .await?;
            info!(
                accepted = ?valid.unit_strings(),
                newest = %valid.newest,
                "valid pop-unit set discovered (newest = mint-into unit)"
            );
            Some(valid)
        }
        Mode::Mock => {
            warn!("BAZAAR_MODE=mock — GATES ARE FREE. Dev/smoke only.");
            None
        }
    };
    // The unit a fresh player mints into (newest valid), or a placeholder in
    // mock mode where no gate ever runs.
    let newest_unit = valid_units
        .as_ref()
        .map(|v| v.newest.clone())
        .unwrap_or_else(|| "pop_mock".to_string());
    let accepted_units = valid_units
        .as_ref()
        .map(|v| v.unit_strings())
        .unwrap_or_default();

    let mut world = world::default_world(cfg.price_spawn, cfg.price_jade, cfg.price_crimson);
    world.speed = cfg.speed;
    // Booth play prices are env-driven (the riddle stays free). Override the
    // baked defaults on the gacha/bell booths from config.
    for booth in &mut world.booths {
        match booth.kind.as_str() {
            "gacha" => booth.price = cfg.price_gacha,
            "bell" => booth.price = cfg.price_bell,
            _ => {}
        }
    }
    // The client-facing mint URL is the FIRST public URL: browsers build their
    // pop wallets on it.  The server's direct URL (`cfg.mint_url`) stays the
    // upstream for the proxy and for redeeming.
    let client_mint_url = cfg
        .mint_public_urls
        .first()
        .cloned()
        .unwrap_or_else(|| cfg.mint_url.clone());

    let game_config = GameConfig {
        mint_url: client_mint_url,
        unit: newest_unit.clone(),
        accepted_units: accepted_units.clone(),
        prices: [
            ("spawn".to_string(), cfg.price_spawn),
            ("court.jade".to_string(), cfg.price_jade),
            ("court.crimson".to_string(), cfg.price_crimson),
        ]
        .into_iter()
        .collect(),
        mode: cfg.mode,
    };

    let vault = Vault::new(cfg.vault_path.clone());
    match vault.stock() {
        Ok(0) => warn!(path = %cfg.vault_path.display(), "vault is EMPTY — chest claims will fail until stocked"),
        Ok(n) => info!(stock = n, "vault loaded"),
        Err(e) => warn!("vault unreadable ({e}) — chest claims will fail"),
    }

    // The revenue sink is a WALLET. In live mode, refuse to boot if we cannot
    // open it — taking pops we cannot durably record is lost money. Mock mode
    // runs no payments, so no sink.
    let sink = match cfg.mode {
        Mode::Live => {
            let sink = RevenueSink::open(cfg.revenue_sink_path.clone()).map_err(|e| {
                anyhow::anyhow!(
                    "cannot open revenue sink {:?}: {e} — refusing to take payments without a durable sink",
                    cfg.revenue_sink_path
                )
            })?;
            info!(path = %cfg.revenue_sink_path.display(), "revenue sink open (WALLET — back this file up)");
            Some(sink)
        }
        Mode::Mock => None,
    };

    let app = Game::with_sink(world, game_config, vault, sink, cfg.gacha_n);
    tokio::spawn(game::tick_loop(app.clone()));

    // Gate routes. Live = the MULTI-UNIT dispatch router: one charge state per
    // (gate x currently-valid unit), all sharing ONE binding key, refreshed by
    // a background re-probe so the accepted set tracks the mint's rotation.
    // Mock = free gates. The single binding key is operator-configured
    // (BAZAAR_BINDING_KEY) so outstanding challenges survive a restart/deploy;
    // unset = a fresh per-boot key.
    let gate_routes = match cfg.mode {
        Mode::Live => {
            let valid = valid_units.expect("live mode always has a valid set");
            let public_mints: Vec<MintUrl> = cfg
                .mint_public_urls
                .iter()
                .map(|u| {
                    MintUrl::from_str(u)
                        .map_err(|e| anyhow::anyhow!("BAZAAR_MINT_PUBLIC_URLS entry {:?}: {e}", u))
                })
                .collect::<anyhow::Result<_>>()?;

            let binding_key = match &cfg.binding_key_hex {
                Some(hex) => BindingKey::from_hex(hex)
                    .map_err(|e| anyhow::anyhow!("BAZAAR_BINDING_KEY: {e}"))?,
                None => {
                    warn!(
                        "BAZAAR_BINDING_KEY unset — using a per-boot key; \
                         outstanding challenges die on restart. Set it as a Fly \
                         secret for deploy-survival (see docs/fly-deploy.md)."
                    );
                    BindingKey::generate()
                }
            };

            let specs = vec![
                GateSpec { gate_id: "spawn".into(), amount: cfg.price_spawn, label: "spawn a body".into() },
                GateSpec { gate_id: "court.jade".into(), amount: cfg.price_jade, label: "Jade Court entry".into() },
                GateSpec { gate_id: "court.crimson".into(), amount: cfg.price_crimson, label: "Crimson Court entry".into() },
                GateSpec { gate_id: "play.gacha".into(), amount: cfg.price_gacha, label: "Gacha shrine pull".into() },
                GateSpec { gate_id: "play.bell".into(), amount: cfg.price_bell, label: "Timing bell play".into() },
            ];

            let gates = MultiUnitGates::new(
                valid,
                specs,
                public_mints,
                binding_key,
                Duration::from_secs(cfg.challenge_ttl_secs),
                Duration::from_secs(cfg.mint_timeout_secs),
            )?;

            // Background re-probe: refresh the valid-unit set every
            // BAZAAR_UNIT_REFRESH_SECS so a rotation is picked up (a new unit
            // added, an expired one dropped) without a restart. The shared
            // GameConfig the client reads is also kept in step.
            spawn_unit_refresh(
                gates.clone(),
                app.clone(),
                cfg.mint_url.clone(),
                Duration::from_secs(cfg.mint_timeout_secs),
                Duration::from_secs(cfg.unit_refresh_secs),
            );

            gates::gated_router_multi(app.clone(), gates)
        }
        Mode::Mock => gates::mock_router(app.clone()),
    };

    // Shared reqwest client for the mint proxy (same client the gate middleware's
    // CdkMintClient uses internally; one connection pool for all mint traffic).
    let proxy_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.mint_timeout_secs))
        .build()
        .expect("reqwest proxy client");
    let proxy_upstream = cfg.mint_url.clone();

    // Build the proxy router as a separate sub-router so it can carry its own
    // (client, upstream) state without conflicting with AppState.
    let proxy_router = {
        let client = proxy_client.clone();
        let upstream = proxy_upstream.clone();
        Router::new()
            .route(
                "/mint/*path",
                get(mint_proxy).post(mint_proxy),
            )
            .with_state(MintProxyState {
                client,
                upstream,
            })
    };

    let router = Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/api/config", get(api_config))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(app.clone())
        .merge(gate_routes)
        .merge(proxy_router)
        .fallback_service(ServeDir::new(&cfg.static_dir));

    let listener = tokio::net::TcpListener::bind(cfg.bind).await?;
    info!("listening on http://{}", cfg.bind);
    axum::serve(listener, router).await?;
    Ok(())
}

/// Background re-probe: every `interval`, re-read `/v1/keysets`, recompute the
/// valid-unit set, and (on success) refresh both the gate dispatch registry
/// (which units are accepted) and the live `GameConfig` advertisement (newest +
/// accepted). A failed probe is logged and skipped — the previous set stands,
/// so a transient mint blip never blanks the gates.
fn spawn_unit_refresh(
    gates: Arc<MultiUnitGates<night_bazaar_server::multiunit::LiveCredential>>,
    app: AppState,
    mint_url: String,
    mint_timeout: Duration,
    interval: Duration,
) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // The first tick fires immediately; skip it (we just probed at boot).
        ticker.tick().await;
        loop {
            ticker.tick().await;
            match mint::fetch_valid_pop_units(&mint_url, mint_timeout).await {
                Ok(valid) => {
                    let newest = valid.newest.clone();
                    let accepted = valid.unit_strings();
                    gates.refresh(valid);
                    app.update_units(newest, accepted);
                }
                Err(e) => {
                    error!("unit re-probe failed (keeping the current valid set): {e}");
                }
            }
        }
    });
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(app): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| game::client_loop(socket, app))
}

async fn api_config(State(app): State<AppState>) -> Json<GameConfig> {
    // The LIVE config: static facts + the current unit advertisement (refreshed
    // on rotation), so a fresh player always mints into the newest valid unit.
    Json(app.current_config())
}
