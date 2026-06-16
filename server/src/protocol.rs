//! Rust mirror of `../../protocol/protocol.ts` — the shared wire protocol.
//!
//! Both sides round-trip `../../protocol/fixtures/messages.json` in their
//! tests, so a drift between this file and the TS source fails a suite.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Header carrying the ws session id on gate POSTs.
pub const SESSION_HEADER: &str = "x-bazaar-session";

/// Axis-aligned rectangle on the ground plane.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub min_x: f64,
    pub max_x: f64,
    pub min_z: f64,
    pub max_z: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, z: f64) -> bool {
        x >= self.min_x && x <= self.max_x && z >= self.min_z && z <= self.max_z
    }
}

/// Door gap in a court's street-facing (min-z) wall.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Door {
    pub x1: f64,
    pub x2: f64,
}

impl Door {
    pub fn covers(&self, x: f64) -> bool {
        x >= self.x1 && x <= self.x2
    }
}

/// A priced court off the street.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CourtSpec {
    pub id: String,
    pub gate: String,
    pub price: u64,
    pub bounds: Rect,
    pub door: Door,
}

/// A chest; claiming hands over a vault token. `court` is a court id or
/// `"street"` (Phase 1a hidden finds). `y` = height (rooftops need the jump).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChestSpec {
    pub id: String,
    pub court: String,
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub z: f64,
}

/// A market stall (Phase 1a, additive). Visuals are client-side; the
/// `footprint` is the authoritative occluder shared by both sides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StallSpec {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
    pub footprint: Rect,
}

/// A playable booth (Phase 1b, additive). `kind` is the game archetype
/// (`"riddle"` | `"gacha"` | `"bell"`); the client renders a marker glow +
/// interact prompt at `(x, z)`. `court` is the owning court id or `"street"`.
/// `price` is the per-play cost in pops (0 = free, e.g. the riddle); paid plays
/// POST `/play/:kind` behind the same middleware as doors. The interact RANGE
/// matches chests (`INTERACT_RANGE`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoothSpec {
    pub id: String,
    pub kind: String,
    pub court: String,
    pub x: f64,
    pub z: f64,
    pub price: u64,
}

/// Point on the ground plane.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub z: f64,
}

/// World geometry + movement constants (server-authoritative, sent in hello).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub street: Rect,
    pub courts: Vec<CourtSpec>,
    pub chests: Vec<ChestSpec>,
    /// Market stalls (Phase 1a, additive): footprints double as occluders.
    #[serde(default)]
    pub stalls: Vec<StallSpec>,
    /// Playable booths (Phase 1b, additive).
    #[serde(default)]
    pub booths: Vec<BoothSpec>,
    pub spawn_ghost: Vec2,
    pub spawn_body: Vec2,
    pub speed: f64,
    pub tick_hz: u32,
}

/// Ghost = free spectator; body = paid spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvatarKind {
    Ghost,
    Body,
}

/// One player in a state snapshot. `y` = jump height (Phase 1a, additive).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayerSnapshot {
    pub id: String,
    pub name: String,
    pub kind: AvatarKind,
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub z: f64,
}

/// One chest in a state snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChestSnapshot {
    pub id: String,
    pub claimed: bool,
}

/// Game config surfaced to the client (hello + `GET /api/config`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameConfig {
    pub mint_url: String,
    /// The unit a FRESH player should mint into: the newest currently-valid
    /// `pop_<ts>` unit (latest `final_expiry`), read from the mint's
    /// `/v1/keysets` at boot and refreshed periodically — never hardcoded.
    pub unit: String,
    /// Every currently-valid `pop_<ts>` unit the server will accept a payment
    /// in (units rotate + overlap; an older-but-unexpired unit is still
    /// honored). The client declares which one it holds on a gate request.
    /// Empty/omitted on legacy/mock configs (back-compatible).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_units: Vec<String>,
    /// BTreeMap so serialization order is stable.
    pub prices: BTreeMap<String, u64>,
    pub mode: Mode,
}

/// live = pops middleware enforced; mock = free gates (dev/smoke only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Live,
    Mock,
}

/* ------------------------------ client → server --------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMsg {
    Join { name: String },
    Move { x: f64, z: f64 },
    /// Jump (Phase 1a): bodies only, only from the ground.
    Jump,
    /// Say something (Phase 1a): bodies only, clipped + rate-limited.
    Chat { text: String },
    Interact { target: String },
    /// Answer a riddle booth (Phase 1b): the free riddle lantern. `booth` is
    /// the booth id the player is standing at; `text` is their typed guess.
    Answer { booth: String, text: String },
}

/* ------------------------------ server → client --------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerMsg {
    Hello {
        session: String,
        world: World,
        config: GameConfig,
    },
    State {
        tick: u64,
        players: Vec<PlayerSnapshot>,
        chests: Vec<ChestSnapshot>,
    },
    Entitlement {
        gate: String,
    },
    Prize {
        chest: String,
        token: String,
    },
    /// Chat relay (Phase 1a): broadcast; `from` = the speaker's session id.
    Chat {
        from: String,
        name: String,
        text: String,
    },
    /// A riddle booth's current prompt (Phase 1b), sent to the interacting
    /// session when it engages the lantern. `booth` is the booth id.
    Riddle {
        booth: String,
        prompt: String,
    },
    /// A bell rang nearby (Phase 1b): broadcast so others hear the chime.
    /// `from` = the session that rang it; `hit` = whether they timed it.
    BellRing {
        booth: String,
        from: String,
        hit: bool,
    },
    Error {
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Round-trip every shared fixture: parse as the typed enum, re-serialize,
    /// compare as `Value` (field-order independent). A TS-side shape change
    /// that lands in fixtures fails here; a Rust-side change fails the TS
    /// suite symmetrically.
    #[test]
    fn protocol_fixtures_round_trip() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../protocol/fixtures/messages.json"
        );
        let raw = std::fs::read_to_string(path).expect("shared fixtures readable");
        let fixtures: Value = serde_json::from_str(&raw).unwrap();

        let client_msgs = fixtures["clientMsgs"].as_array().unwrap();
        assert!(!client_msgs.is_empty());
        for fixture in client_msgs {
            let typed: ClientMsg = serde_json::from_value(fixture.clone())
                .unwrap_or_else(|e| panic!("client fixture {fixture} failed: {e}"));
            let back = serde_json::to_value(&typed).unwrap();
            assert_eq!(&back, fixture, "client msg round-trip drifted");
        }

        let server_msgs = fixtures["serverMsgs"].as_array().unwrap();
        assert!(!server_msgs.is_empty());
        for fixture in server_msgs {
            let typed: ServerMsg = serde_json::from_value(fixture.clone())
                .unwrap_or_else(|e| panic!("server fixture {fixture} failed: {e}"));
            let back = serde_json::to_value(&typed).unwrap();
            assert_eq!(&back, fixture, "server msg round-trip drifted");
        }
    }
}
