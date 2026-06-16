//! Environment-driven configuration. Every knob has a sane spike default;
//! defaults assume `cwd = night-bazaar/server`.

use std::net::SocketAddr;
use std::path::PathBuf;

use crate::protocol::Mode;

#[derive(Debug, Clone)]
pub struct Config {
    /// BAZAAR_BIND — listen address. Default = the turtle tailnet directive.
    pub bind: SocketAddr,
    /// BAZAAR_MINT_URL — the shared Mutinynet rig (never run your own mintd).
    /// Server-side DIRECT URL used for mint probing, redeeming, and the proxy
    /// upstream.  Semantics unchanged from before.
    pub mint_url: String,
    /// BAZAAR_MINT_PUBLIC_URLS — comma-separated list of mint URLs as clients
    /// see them (e.g. `http://localhost:8410/mint,http://100.x.x.x:8410/mint`).
    ///
    /// - FIRST entry → `/api/config` `mintUrl` (browsers build wallets on it).
    /// - FULL list   → middleware accepted-mints allowlist AND creqA `m` list.
    ///
    /// Unset → falls back to `[mint_url]`; dev stays zero-config.
    pub mint_public_urls: Vec<String>,
    /// BAZAAR_MODE — "live" (pops middleware, default) | "mock" (free gates).
    pub mode: Mode,
    /// BAZAAR_PRICE_SPAWN / _JADE / _CRIMSON — pops per gate.
    pub price_spawn: u64,
    pub price_jade: u64,
    pub price_crimson: u64,
    /// BAZAAR_PRICE_GACHA / _BELL — pops per paid play (booths).
    pub price_gacha: u64,
    pub price_bell: u64,
    /// BAZAAR_GACHA_N — deterministic gacha wins every Nth pull (server
    /// counter; no randomness).
    pub gacha_n: u64,
    /// BAZAAR_SPEED — walk speed, world units/sec (server-authoritative; feel knob).
    pub speed: f64,
    /// BAZAAR_VAULT — prize token file (JSON array of cashuB strings).
    pub vault_path: PathBuf,
    /// BAZAAR_REVENUE_SINK — append-only JSONL of every redeemed gate/play
    /// proof. THIS FILE IS A WALLET (spendable bearer value) — persist + back
    /// it up. Default sits beside the vault.
    pub revenue_sink_path: PathBuf,
    /// BAZAAR_STATIC — built client to serve at `/`.
    pub static_dir: PathBuf,
    /// BAZAAR_BINDING_KEY — hex server secret for challenge binding; unset =
    /// per-boot key (outstanding challenges die on restart; clients refetch).
    pub binding_key_hex: Option<String>,
    /// BAZAAR_CHALLENGE_TTL_SECS — challenge `expires` lifetime.
    pub challenge_ttl_secs: u64,
    /// BAZAAR_MINT_TIMEOUT_SECS — per-call bound on mint HTTP (503 beyond it).
    pub mint_timeout_secs: u64,
    /// BAZAAR_UNIT_REFRESH_SECS — how often the background task re-probes
    /// `/v1/keysets` to refresh the accepted `pop_<ts>` unit set (so a rotation
    /// is picked up without a restart). Default 300 s (5 min).
    pub unit_refresh_secs: u64,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn parse_or<T: std::str::FromStr>(name: &str, default: T) -> anyhow::Result<T> {
    match var(name) {
        None => Ok(default),
        Some(raw) => raw
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("{name}={raw:?} does not parse")),
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let mode = match var("BAZAAR_MODE").as_deref() {
            None | Some("live") => Mode::Live,
            Some("mock") => Mode::Mock,
            Some(other) => anyhow::bail!("BAZAAR_MODE={other:?} (want live|mock)"),
        };
        let mint_url = var("BAZAAR_MINT_URL")
            .unwrap_or_else(|| "http://127.0.0.1:28338".to_string());
        // Parse BAZAAR_MINT_PUBLIC_URLS: comma-separated, trimmed, non-empty
        // entries.  Unset or empty → fall back to [mint_url].
        let mint_public_urls: Vec<String> = match var("BAZAAR_MINT_PUBLIC_URLS") {
            None => vec![mint_url.clone()],
            Some(raw) => {
                let urls: Vec<String> = raw
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if urls.is_empty() {
                    vec![mint_url.clone()]
                } else {
                    urls
                }
            }
        };
        Ok(Self {
            bind: parse_or("BAZAAR_BIND", "100.96.251.111:8410".parse().unwrap())?,
            mint_url,
            mint_public_urls,
            mode,
            price_spawn: parse_or("BAZAAR_PRICE_SPAWN", 10)?,
            price_jade: parse_or("BAZAAR_PRICE_JADE", 50)?,
            price_crimson: parse_or("BAZAAR_PRICE_CRIMSON", 200)?,
            price_gacha: parse_or("BAZAAR_PRICE_GACHA", 5)?,
            price_bell: parse_or("BAZAAR_PRICE_BELL", 3)?,
            gacha_n: parse_or("BAZAAR_GACHA_N", 8)?,
            speed: parse_or("BAZAAR_SPEED", 12.0)?,
            vault_path: var("BAZAAR_VAULT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("../vault/tokens.json")),
            revenue_sink_path: var("BAZAAR_REVENUE_SINK")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("../vault/revenue.jsonl")),
            static_dir: var("BAZAAR_STATIC")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("../client/dist")),
            binding_key_hex: var("BAZAAR_BINDING_KEY"),
            challenge_ttl_secs: parse_or("BAZAAR_CHALLENGE_TTL_SECS", 300)?,
            mint_timeout_secs: parse_or("BAZAAR_MINT_TIMEOUT_SECS", 10)?,
            unit_refresh_secs: parse_or("BAZAAR_UNIT_REFRESH_SECS", 300)?,
        })
    }
}
