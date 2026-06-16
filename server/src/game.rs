//! The game core: sessions, server-authoritative positions, entitlements,
//! the tick loop, and the websocket handler.
//!
//! Entitlements are keyed (session, gate) and live exactly as long as the ws
//! session: a reconnect is a NEW session and pays again (the contract's
//! "session-bound re-entry free, new session pays").

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{Sink, SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::protocol::{
    AvatarKind, ChestSnapshot, ClientMsg, GameConfig, PlayerSnapshot, ServerMsg, Vec2, World,
};
use crate::sink::{RevenueSink, SinkError};
use crate::vault::{Vault, VaultError};
use crate::world::{region_of, step, step_y, MoveCaps, Region, JUMP_VY};
use pops_core_verify::redeemer::Redeemed;

/// Interaction reach for chests, world units (3D; rooftop finds need the
/// jump apex to come into range).
const INTERACT_RANGE: f64 = 3.0;
/// Max display-name length (clipped, not rejected).
const MAX_NAME: usize = 24;
/// Max chat message length (clipped, not rejected).
const MAX_CHAT: usize = 200;
/// Minimum time between chat messages per session.
const CHAT_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(1);
/// Per-session outbound message buffer; a stalled client drops frames rather
/// than stalling the tick loop.
const OUTBOX: usize = 64;
/// Minimum time between riddle guesses per session (contract: 1 guess / 3s).
const GUESS_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(3);
/// A bell play expires this long after it starts (contract: 15s).
const BELL_PLAY_TTL: std::time::Duration = std::time::Duration::from_secs(15);
/// Bell pendulum full-swing period (server + client share it via the play).
const BELL_PERIOD_MS: u64 = 1800;
/// Bell timing tolerance window around a sweet spot.
const BELL_TOLERANCE_MS: u64 = 140;

/// A live timing-bell play, server-clock authoritative. One per session at a
/// time; a press is judged against `started` on the SERVER clock so a scripted
/// client gains nothing the server clock does not allow.
pub struct BellPlay {
    pub booth: String,
    pub started: std::time::Instant,
}

/// Result of the shared reach gate (body + room + range + line of sight). The
/// refusal carries the ws error to push (boxed; `ServerMsg::Hello` is large).
enum Reach {
    Ok,
    Refused(Box<ServerMsg>),
}

/// Outcome of a paid GACHA pull's game-side effect (after the pop is redeemed
/// + persisted). The handler turns this into the HTTP body.
#[derive(Debug, Clone)]
pub struct GachaPlayOutcome {
    pub win: bool,
    pub fortune: &'static str,
    pub pity: u64,
    /// The prize token, present only on a win WITH stock.
    pub token: Option<String>,
    /// True when the pull won but the booth's prize stock was empty.
    pub sold_out: bool,
}

/// Outcome of a BELL press's game-side judgement.
#[derive(Debug, Clone)]
pub struct BellPressOutcome {
    pub hit: bool,
    pub offset_ms: u64,
    pub token: Option<String>,
    pub sold_out: bool,
}

/// Why a paid play could not bind to a session (the cousin of GrantError).
#[derive(Debug, PartialEq, Eq)]
pub enum PlayError {
    /// No live ws session with that id.
    UnknownSession,
    /// The session is not a body (must spawn first).
    NotABody,
    /// The session is not in the booth's room / range / line of sight.
    OutOfReach,
    /// No live bell play for this session (or it expired).
    NoLivePlay,
}

pub struct Player {
    pub name: String,
    pub kind: AvatarKind,
    pub pos: (f64, f64),
    /// Jump height + vertical velocity (Phase 1a; grounded = both 0).
    pub y: f64,
    pub vy: f64,
    pub intent: (f64, f64),
    /// Gate ids this session has paid ("spawn", "court.jade", …).
    pub entitlements: std::collections::HashSet<String>,
    /// Last accepted chat message (rate limiting).
    last_chat: Option<std::time::Instant>,
    /// Last riddle guess (rate limiting, separate from chat).
    last_guess: Option<std::time::Instant>,
    /// Booth ids this session has already WON (max 1 win/session/booth).
    booths_won: std::collections::HashSet<String>,
    tx: mpsc::Sender<ServerMsg>,
}

impl Player {
    fn caps(&self, world: &World) -> MoveCaps {
        MoveCaps {
            body: self.kind == AvatarKind::Body,
            courts: world
                .courts
                .iter()
                .map(|c| self.entitlements.contains(&c.gate))
                .collect(),
        }
    }

    /// Best-effort push; a full outbox drops the frame (state snapshots are
    /// idempotent, targeted messages are re-derivable from /api/config).
    fn push(&self, msg: ServerMsg) {
        if let Err(e) = self.tx.try_send(msg) {
            debug!("dropping ws frame for stalled client: {e}");
        }
    }
}

#[derive(Default)]
pub struct GameInner {
    pub players: HashMap<String, Player>,
    /// One-shot per stock: set on first claim, cleared only by restart
    /// (deliberate restock; design v1 "first finder takes"). Booth prize
    /// stocks share this map keyed by booth id, but unlike chests a booth is
    /// NOT one-shot: it depletes per win and is re-derived from live stock.
    pub chest_claimed: HashMap<String, bool>,
    /// Total gacha pulls so far (the deterministic every-Nth counter).
    pub gacha_count: u64,
    /// Current riddle index (global; advances on each win).
    pub riddle_index: usize,
    /// Live timing-bell plays, keyed by session (one per session).
    pub bell_plays: HashMap<String, BellPlay>,
    pub tick: u64,
}

/// The live, refreshable unit advertisement: the newest (mint-into) unit and
/// the full accepted set. The unit-refresh task updates it; `current_config`
/// overlays it onto the static [`GameConfig`] so `/api/config` and the ws hello
/// reflect a rotation without a restart.
#[derive(Debug, Clone, Default)]
pub struct UnitView {
    pub newest: String,
    pub accepted: Vec<String>,
}

pub struct Game {
    pub world: World,
    /// Static config (mint URL, prices, mode). The unit fields are seeded here
    /// but the LIVE values come from `units` via [`Game::current_config`].
    pub config: GameConfig,
    /// Live unit advertisement, refreshed by the re-probe task.
    pub units: RwLock<UnitView>,
    pub vault: Vault,
    /// The revenue sink: every redeemed gate/play proof is persisted here
    /// BEFORE the entitlement is granted / the play result returns. `None` in
    /// mock mode (no payments run, so nothing to persist).
    pub sink: Option<RevenueSink>,
    /// Deterministic gacha: a win every Nth pull (no randomness).
    pub gacha_n: u64,
    pub inner: Mutex<GameInner>,
}

pub type AppState = Arc<Game>;

/// Persist a redemption to the sink, mapping a sink failure to a value the
/// caller can turn into an error response. A redemption with no sink configured
/// is a programming error in live mode (the binary always wires one), but
/// rather than panic mid-request we surface it as a persist failure so the
/// caller refuses to grant rather than silently dropping the money.
impl Game {
    pub fn persist_revenue(
        &self,
        gate: &str,
        session: &str,
        redeemed: &Redeemed,
    ) -> Result<(), SinkError> {
        match &self.sink {
            Some(sink) => sink.record(gate, session, redeemed),
            None => Err(SinkError {
                message: "no revenue sink configured but a payment was redeemed".to_string(),
            }),
        }
    }
}

/// Granting can fail only on an unknown session (the payment middleware runs
/// FIRST, so by the time the handler sees the request the pop is already
/// redeemed. An unknown session is a paid-but-unfulfillable request (the
/// in-process cousin of the gateway's documented paid-but-upstream-down edge).
#[derive(Debug, PartialEq, Eq)]
pub enum GrantError {
    UnknownSession,
}

/// Default deterministic-gacha cadence (a win every Nth pull). Overridden by
/// `BAZAAR_GACHA_N` in the binary; tests use this default.
pub const DEFAULT_GACHA_N: u64 = 8;

impl Game {
    pub fn new(world: World, config: GameConfig, vault: Vault) -> AppState {
        Self::with_sink(world, config, vault, None, DEFAULT_GACHA_N)
    }

    pub fn with_sink(
        world: World,
        config: GameConfig,
        vault: Vault,
        sink: Option<RevenueSink>,
        gacha_n: u64,
    ) -> AppState {
        // A chest with no stock renders as already-looted from boot; the
        // keeper restocks the vault file and restarts to bring one to life.
        // Booth prize stocks behave identically (keyed by booth id).
        let mut chest_claimed = HashMap::new();
        for chest in &world.chests {
            let stocked = vault.stock_for(&chest.id).unwrap_or(0) > 0;
            chest_claimed.insert(chest.id.clone(), !stocked);
        }
        // Seed the live unit view from the static config (the binary refreshes
        // it from the mint; tests leave it as-is).
        let units = RwLock::new(UnitView {
            newest: config.unit.clone(),
            accepted: if config.accepted_units.is_empty() {
                vec![config.unit.clone()]
            } else {
                config.accepted_units.clone()
            },
        });
        Arc::new(Self {
            world,
            config,
            units,
            vault,
            sink,
            gacha_n,
            inner: Mutex::new(GameInner {
                chest_claimed,
                ..Default::default()
            }),
        })
    }

    /// The config a client sees right now: the static facts with the LIVE unit
    /// advertisement (newest + accepted) overlaid, so a mid-life rotation shows
    /// up on `/api/config` and new ws connections without a restart.
    pub fn current_config(&self) -> GameConfig {
        let view = self.units.read().expect("units lock poisoned");
        let mut cfg = self.config.clone();
        cfg.unit = view.newest.clone();
        cfg.accepted_units = view.accepted.clone();
        cfg
    }

    /// Replace the live unit advertisement (called by the re-probe task after a
    /// successful refresh).
    pub fn update_units(&self, newest: String, accepted: Vec<String>) {
        let mut view = self.units.write().expect("units lock poisoned");
        view.newest = newest;
        view.accepted = accepted;
    }

    /// Register a session: issue an id, place a ghost at the ghost spawn.
    /// Returns (session_id, hello message).
    pub fn connect(&self, tx: mpsc::Sender<ServerMsg>) -> (String, ServerMsg) {
        let id = new_session_id();
        let player = Player {
            name: format!("ghost-{}", &id[..4]),
            kind: AvatarKind::Ghost,
            pos: (self.world.spawn_ghost.x, self.world.spawn_ghost.z),
            y: 0.0,
            vy: 0.0,
            intent: (0.0, 0.0),
            entitlements: Default::default(),
            last_chat: None,
            last_guess: None,
            booths_won: Default::default(),
            tx,
        };
        let mut inner = self.inner.lock().unwrap();
        inner.players.insert(id.clone(), player);
        let hello = ServerMsg::Hello {
            session: id.clone(),
            world: self.world.clone(),
            config: self.current_config(),
        };
        info!(session = %id, "session connected (ghost)");
        (id, hello)
    }

    pub fn disconnect(&self, session: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.players.remove(session);
        info!(%session, "session disconnected (entitlements died with it)");
    }

    /// Mark a paid entitlement. For "spawn", flip ghost -> body at the body
    /// spawn. Idempotent per (session, gate). Pushes the `entitlement` ws
    /// message so the client's door/body opens.
    pub fn grant(&self, session: &str, gate: &str) -> Result<(), GrantError> {
        let mut inner = self.inner.lock().unwrap();
        let player = inner
            .players
            .get_mut(session)
            .ok_or(GrantError::UnknownSession)?;
        let fresh = player.entitlements.insert(gate.to_string());
        if gate == "spawn" && player.kind == AvatarKind::Ghost {
            player.kind = AvatarKind::Body;
            player.pos = (self.world.spawn_body.x, self.world.spawn_body.z);
            player.y = 0.0;
            player.vy = 0.0;
            player.intent = (0.0, 0.0);
        }
        info!(%session, %gate, fresh, "entitlement granted");
        player.push(ServerMsg::Entitlement {
            gate: gate.to_string(),
        });
        Ok(())
    }

    /// True iff the session currently holds the gate (used by tests and the
    /// gate handlers' idempotency checks).
    pub fn is_entitled(&self, session: &str, gate: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .players
            .get(session)
            .map(|p| p.entitlements.contains(gate))
            .unwrap_or(false)
    }

    pub fn handle_client_msg(&self, session: &str, msg: ClientMsg) {
        match msg {
            ClientMsg::Join { name } => {
                let mut inner = self.inner.lock().unwrap();
                if let Some(p) = inner.players.get_mut(session) {
                    let trimmed: String = name.trim().chars().take(MAX_NAME).collect();
                    if !trimmed.is_empty() {
                        p.name = trimmed;
                    }
                }
            }
            ClientMsg::Move { x, z } => {
                let mut inner = self.inner.lock().unwrap();
                if let Some(p) = inner.players.get_mut(session) {
                    let clean = |v: f64| if v.is_finite() { v } else { 0.0 };
                    p.intent = (clean(x), clean(z));
                }
            }
            ClientMsg::Jump => {
                let mut inner = self.inner.lock().unwrap();
                if let Some(p) = inner.players.get_mut(session) {
                    // Bodies only (ghosts drift, they do not hop) and only
                    // from the ground; no double jumps. Silent no-op
                    // otherwise: jump spam must not earn an error stream.
                    if p.kind == AvatarKind::Body && p.y == 0.0 && p.vy == 0.0 {
                        p.vy = JUMP_VY;
                    }
                }
            }
            ClientMsg::Chat { text } => self.chat(session, &text),
            ClientMsg::Interact { target } => self.interact(session, &target),
            ClientMsg::Answer { booth, text } => self.answer_riddle(session, &booth, &text),
        }
    }

    /// Chat relay: bodies only, clipped to MAX_CHAT printable chars, at most
    /// one message per CHAT_COOLDOWN. Broadcast to EVERYONE (ghosts read).
    fn chat(&self, session: &str, text: &str) {
        let clean: String = text
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_CHAT)
            .collect::<String>()
            .trim()
            .to_string();
        if clean.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        let Some(player) = inner.players.get_mut(session) else {
            return;
        };
        if player.kind != AvatarKind::Body {
            player.push(err("not-a-body", "ghosts have no voice — buy a body to speak"));
            return;
        }
        let now = std::time::Instant::now();
        if let Some(last) = player.last_chat {
            if now.duration_since(last) < CHAT_COOLDOWN {
                player.push(err("chat-rate", "easy — one message a second"));
                return;
            }
        }
        player.last_chat = Some(now);
        debug!(%session, chars = clean.chars().count(), "chat relayed");
        let msg = ServerMsg::Chat {
            from: session.to_string(),
            name: player.name.clone(),
            text: clean,
        };
        for p in inner.players.values() {
            p.push(msg.clone());
        }
    }

    /// Interact: route a chest claim or a booth engage by target id.
    fn interact(&self, session: &str, target: &str) {
        if self.world.booths.iter().any(|b| b.id == target) {
            self.engage_booth(session, target);
            return;
        }
        self.claim_chest(session, target);
    }

    /// Engage a booth by interacting (the FREE riddle lantern sends its prompt;
    /// paid booths are reached over HTTP, so interacting just nudges the player
    /// toward the pay flow). Reuses the same body/room/reach gate as chests.
    fn engage_booth(&self, session: &str, booth_id: &str) {
        let inner = self.inner.lock().unwrap();
        let Some(booth) = self.world.booths.iter().find(|b| b.id == booth_id) else {
            return;
        };
        match self.reach_check(&inner, session, (booth.x, 0.0, booth.z), &booth.court, "booth") {
            Reach::Ok => {}
            Reach::Refused(msg) => {
                if let Some(p) = inner.players.get(session) {
                    p.push(*msg);
                }
                return;
            }
        }
        match booth.kind.as_str() {
            "riddle" => {
                let prompt = crate::booth::riddle_prompt(inner.riddle_index).to_string();
                debug!(%session, booth = %booth_id, "riddle engaged");
                inner.players[session].push(ServerMsg::Riddle {
                    booth: booth_id.to_string(),
                    prompt,
                });
            }
            // Paid booths: the play IS the paid request; interacting here is
            // just a hint (the client opens the pay flow). Nothing to grant.
            _ => {
                inner.players[session].push(err(
                    "pay-to-play",
                    "this booth charges per play — use the pay prompt",
                ));
            }
        }
    }

    /// Chest claim: body + inside the chest's court + in range + clear line of
    /// sight + unclaimed. Hands out ONE vault token to the first finder. All
    /// checks and the vault pop run under the single game lock, so two
    /// simultaneous claims cannot both win.
    fn claim_chest(&self, session: &str, target: &str) {
        let mut inner = self.inner.lock().unwrap();

        let Some(chest) = self.world.chests.iter().find(|c| c.id == target) else {
            if let Some(p) = inner.players.get(session) {
                p.push(err("unknown-target", "nothing to interact with"));
            }
            return;
        };

        match self.reach_check(&inner, session, (chest.x, chest.y, chest.z), &chest.court, "chest") {
            Reach::Ok => {}
            Reach::Refused(msg) => {
                if let Some(p) = inner.players.get(session) {
                    p.push(*msg);
                }
                return;
            }
        }
        if inner.chest_claimed.get(target).copied().unwrap_or(true) {
            inner.players[session].push(err("chest-claimed", "someone got there first"));
            return;
        }

        match self.vault.pop(target) {
            Ok(token) => {
                inner.chest_claimed.insert(target.to_string(), true);
                info!(%session, chest = %target, "chest claimed, vault token handed over");
                inner.players[session].push(ServerMsg::Prize {
                    chest: target.to_string(),
                    token,
                });
            }
            Err(VaultError::Empty { .. }) => {
                warn!(chest = %target, "claim attempted but the vault is empty");
                inner.players[session].push(err("vault-empty", "the vault has nothing to give"));
            }
            Err(e) => {
                warn!("vault failure during claim: {e}");
                inner.players[session].push(err("vault-empty", "the vault failed; try later"));
            }
        }
    }

    /// The shared "can this session reach this world point" gate, used by both
    /// chest claims and booth engages: must be a BODY, in the right room, in
    /// the 3D interact sphere, AND with a clear line of sight (no stall wall
    /// between player and target (fixes the quirk where chest.stall was
    /// claimable THROUGH the trinket stall). `noun` shapes the error prose.
    fn reach_check(
        &self,
        inner: &GameInner,
        session: &str,
        target: (f64, f64, f64),
        court: &str,
        noun: &str,
    ) -> Reach {
        let (tx, ty, tz) = target;
        let refuse = |code: &str, msg: String| Reach::Refused(Box::new(err(code, &msg)));
        let Some(player) = inner.players.get(session) else {
            return refuse("not-a-body", "no such session".to_string());
        };
        if player.kind != AvatarKind::Body {
            return refuse("not-a-body", "ghosts cannot touch the world".to_string());
        }
        let player_region = region_of(&self.world, player.pos.0, player.pos.1);
        let in_right_room = if court == "street" {
            player_region == Region::Street
        } else {
            let idx = self.world.courts.iter().position(|c| c.id == court);
            idx.map(Region::Court) == Some(player_region)
        };
        if !in_right_room {
            return refuse("wrong-room", format!("you are not where the {noun} is"));
        }
        // 3D reach: rooftop chests sit above the interact sphere from the
        // ground; only the jump apex brings them into range.
        let (dx, dy, dz) = (player.pos.0 - tx, player.y - ty, player.pos.1 - tz);
        if (dx * dx + dy * dy + dz * dz).sqrt() > INTERACT_RANGE {
            return refuse("out-of-range", format!("step closer to the {noun} (some need a jump)"));
        }
        // Line of sight: a stall footprint BETWEEN the player and the target
        // blocks reach. Without this, the interact sphere reaches THROUGH a
        // stall wall (the chest.stall quirk). A target/player standing inside a
        // footprint (rooftop chest on its slab) does not self-block.
        if crate::world::segment_blocked_by_stall(
            &self.world,
            (player.pos.0, player.pos.1),
            (tx, tz),
        ) {
            return refuse("out-of-range", format!("a stall is between you and the {noun} — go around"));
        }
        Reach::Ok
    }

    /// Answer the riddle lantern (Phase 1b). Free, but: body + in the booth's
    /// court + in range + line of sight, rate-limited to one guess / 3s, and at
    /// most one win per session per booth. A correct answer hands a prize from
    /// `vault["booth.riddle"]` and ROTATES the riddle globally; a wrong answer
    /// is flavor + retry.
    fn answer_riddle(&self, session: &str, booth_id: &str, text: &str) {
        let mut inner = self.inner.lock().unwrap();

        let Some(booth) = self
            .world
            .booths
            .iter()
            .find(|b| b.id == booth_id && b.kind == "riddle")
        else {
            if let Some(p) = inner.players.get(session) {
                p.push(err("no-riddle", "that is not a riddle booth"));
            }
            return;
        };

        match self.reach_check(&inner, session, (booth.x, 0.0, booth.z), &booth.court, "lantern") {
            Reach::Ok => {}
            Reach::Refused(msg) => {
                if let Some(p) = inner.players.get(session) {
                    p.push(*msg);
                }
                return;
            }
        }

        // Already won this booth this session: no second prize.
        if inner.players[session].booths_won.contains(booth_id) {
            inner.players[session]
                .push(err("already-won", "the lantern already gave you its prize"));
            return;
        }

        // Rate limit: one guess per GUESS_COOLDOWN. A rejected guess must NOT
        // reset the clock (mirrors the chat cooldown rule).
        let now = std::time::Instant::now();
        if let Some(last) = inner.players[session].last_guess {
            if now.duration_since(last) < GUESS_COOLDOWN {
                inner.players[session].push(err("guess-rate", "think a moment — one guess every few seconds"));
                return;
            }
        }
        inner.players.get_mut(session).unwrap().last_guess = Some(now);

        let idx = inner.riddle_index;
        if !crate::booth::riddle_is_correct(idx, text) {
            debug!(%session, booth = %booth_id, "riddle wrong answer");
            inner.players[session].push(err(
                "wrong-answer",
                "the lantern dims — not quite. Try again.",
            ));
            return;
        }

        // Correct. Hand a prize if stock remains, mark the win, rotate the
        // riddle. If stock is empty, still mark the win + rotate (the puzzle was
        // solved) but report the empty vault.
        match self.vault.pop(booth_id) {
            Ok(token) => {
                inner
                    .players
                    .get_mut(session)
                    .unwrap()
                    .booths_won
                    .insert(booth_id.to_string());
                inner.riddle_index = (idx + 1) % crate::booth::riddle_count();
                info!(%session, booth = %booth_id, "riddle solved, prize handed over");
                inner.players[session].push(ServerMsg::Prize {
                    chest: booth_id.to_string(),
                    token,
                });
            }
            Err(VaultError::Empty { .. }) => {
                inner
                    .players
                    .get_mut(session)
                    .unwrap()
                    .booths_won
                    .insert(booth_id.to_string());
                inner.riddle_index = (idx + 1) % crate::booth::riddle_count();
                warn!(booth = %booth_id, "riddle solved but the booth vault is empty");
                inner.players[session]
                    .push(err("vault-empty", "you solved it, but the lantern has no prize left"));
            }
            Err(e) => {
                warn!("vault failure during riddle prize: {e}");
                inner.players[session].push(err("vault-empty", "the lantern failed; try later"));
            }
        }
    }

    /// A paid GACHA pull's game-side effect, run AFTER the pop is redeemed +
    /// persisted. Requires the session to be a body in reach of the gacha
    /// booth (server-authoritative; a paid request from a ghost or someone not
    /// at the shrine is refused; the pop is retained, the player retries in
    /// place). Advances the deterministic counter and pops a prize on a win.
    pub fn play_gacha(&self, session: &str, booth_id: &str) -> Result<GachaPlayOutcome, PlayError> {
        let mut inner = self.inner.lock().unwrap();
        let Some(booth) = self
            .world
            .booths
            .iter()
            .find(|b| b.id == booth_id && b.kind == "gacha")
        else {
            return Err(PlayError::UnknownSession); // unknown booth ~ nothing to bind
        };
        self.gate_paid_play(&inner, session, booth)?;

        inner.gacha_count += 1;
        let count = inner.gacha_count;
        let outcome = crate::booth::gacha_outcome(count, self.gacha_n);
        let (token, sold_out) = if outcome.win {
            match self.vault.pop(booth_id) {
                Ok(t) => (Some(t), false),
                Err(VaultError::Empty { .. }) => (None, true),
                Err(e) => {
                    warn!("gacha vault failure: {e}");
                    (None, true)
                }
            }
        } else {
            (None, false)
        };
        info!(%session, booth = %booth_id, count, win = outcome.win, sold_out, "gacha pull resolved");
        Ok(GachaPlayOutcome {
            win: outcome.win,
            fortune: outcome.fortune,
            pity: outcome.pity,
            token,
            sold_out,
        })
    }

    /// Start a paid BELL play, run AFTER the pop is redeemed + persisted.
    /// Requires a body in reach of the bell booth. Records the start time on
    /// the SERVER clock; replaces any prior live play for this session (one at
    /// a time). Returns the play handle the client renders the pendulum from.
    pub fn play_bell_start(
        &self,
        session: &str,
        booth_id: &str,
    ) -> Result<(String, u64, u64, u64), PlayError> {
        let mut inner = self.inner.lock().unwrap();
        let Some(booth) = self
            .world
            .booths
            .iter()
            .find(|b| b.id == booth_id && b.kind == "bell")
        else {
            return Err(PlayError::UnknownSession);
        };
        self.gate_paid_play(&inner, session, booth)?;

        let play_id = new_session_id(); // reuse the 64-bit hex id minter
        inner.bell_plays.insert(
            session.to_string(),
            BellPlay {
                booth: booth_id.to_string(),
                started: std::time::Instant::now(),
            },
        );
        info!(%session, booth = %booth_id, %play_id, "bell play started (server clock)");
        Ok((
            play_id,
            BELL_PERIOD_MS,
            BELL_TOLERANCE_MS,
            BELL_PLAY_TTL.as_millis() as u64,
        ))
    }

    /// Judge a BELL press (free, session-checked). Computes the offset from the
    /// SERVER clock and the play's start; within tolerance = a prize from
    /// `vault["booth.bell"]`. The live play is consumed (one shot per play).
    /// Broadcasts a `BellRing` so nearby players hear the chime.
    pub fn play_bell_press(&self, session: &str) -> Result<BellPressOutcome, PlayError> {
        let mut inner = self.inner.lock().unwrap();
        // Must still be a live ws session.
        if !inner.players.contains_key(session) {
            return Err(PlayError::UnknownSession);
        }
        let play = match inner.bell_plays.get(session) {
            Some(p) => p,
            None => return Err(PlayError::NoLivePlay),
        };
        let elapsed = play.started.elapsed();
        let booth_id = play.booth.clone();
        // Expired plays cannot be pressed.
        if elapsed > BELL_PLAY_TTL {
            inner.bell_plays.remove(session);
            return Err(PlayError::NoLivePlay);
        }
        let elapsed_ms = elapsed.as_millis() as u64;
        let offset_ms = crate::booth::bell_offset_ms(elapsed_ms, BELL_PERIOD_MS);
        let hit = offset_ms <= BELL_TOLERANCE_MS;
        // One shot: consume the play whether or not it hit.
        inner.bell_plays.remove(session);

        let (token, sold_out) = if hit {
            match self.vault.pop(&booth_id) {
                Ok(t) => (Some(t), false),
                Err(VaultError::Empty { .. }) => (None, true),
                Err(e) => {
                    warn!("bell vault failure: {e}");
                    (None, true)
                }
            }
        } else {
            (None, false)
        };
        info!(%session, booth = %booth_id, elapsed_ms, offset_ms, hit, sold_out, "bell press judged");

        // Hand the prize to the presser…
        if let Some(ref t) = token {
            inner.players[session].push(ServerMsg::Prize {
                chest: booth_id.clone(),
                token: t.clone(),
            });
        }
        // …and let everyone hear the bell.
        let ring = ServerMsg::BellRing {
            booth: booth_id.clone(),
            from: session.to_string(),
            hit,
        };
        for p in inner.players.values() {
            p.push(ring.clone());
        }
        Ok(BellPressOutcome {
            hit,
            offset_ms,
            token,
            sold_out,
        })
    }

    /// Shared gate for a paid play's game-side effect: the session must be a
    /// live body in reach of the booth. Maps the reach refusal to a PlayError.
    fn gate_paid_play(
        &self,
        inner: &GameInner,
        session: &str,
        booth: &crate::protocol::BoothSpec,
    ) -> Result<(), PlayError> {
        if !inner.players.contains_key(session) {
            return Err(PlayError::UnknownSession);
        }
        match self.reach_check(inner, session, (booth.x, 0.0, booth.z), &booth.court, "booth") {
            Reach::Ok => Ok(()),
            Reach::Refused(msg) => match *msg {
                ServerMsg::Error { code, .. } if code == "not-a-body" => Err(PlayError::NotABody),
                _ => Err(PlayError::OutOfReach),
            },
        }
    }

    /// One tick: integrate every player's intent, then fan a full snapshot to
    /// everyone (player counts are tiny in v0).
    pub fn tick(&self, dt: f64) {
        let mut inner = self.inner.lock().unwrap();
        inner.tick += 1;
        let tick = inner.tick;

        let ids: Vec<String> = inner.players.keys().cloned().collect();
        for id in &ids {
            let player = &inner.players[id];
            let caps = player.caps(&self.world);
            let next = step(&self.world, &caps, player.pos, player.intent, dt);
            let (y, vy) = if player.y > 0.0 || player.vy != 0.0 {
                step_y(player.y, player.vy, dt)
            } else {
                (0.0, 0.0)
            };
            let p = inner.players.get_mut(id).unwrap();
            p.pos = next;
            p.y = y;
            p.vy = vy;
        }

        let players: Vec<PlayerSnapshot> = inner
            .players
            .iter()
            .map(|(id, p)| PlayerSnapshot {
                id: id.clone(),
                name: p.name.clone(),
                kind: p.kind,
                x: p.pos.0,
                y: p.y,
                z: p.pos.1,
            })
            .collect();
        let chests: Vec<ChestSnapshot> = self
            .world
            .chests
            .iter()
            .map(|c| ChestSnapshot {
                id: c.id.clone(),
                claimed: inner.chest_claimed.get(&c.id).copied().unwrap_or(false),
            })
            .collect();
        let snapshot = ServerMsg::State {
            tick,
            players,
            chests,
        };
        for p in inner.players.values() {
            p.push(snapshot.clone());
        }
    }

    /// Where a session currently stands (tests + ops).
    pub fn position_of(&self, session: &str) -> Option<Vec2> {
        let inner = self.inner.lock().unwrap();
        inner
            .players
            .get(session)
            .map(|p| Vec2 { x: p.pos.0, z: p.pos.1 })
    }

    /// Test/ops support: force a session's kind + ground position (bypasses
    /// movement rules). Used by integration tests to place a body at a booth
    /// without walking it through a court; harmless in ops (positions are
    /// server-authoritative and re-derived each tick from intent).
    pub fn force_place(&self, session: &str, kind: AvatarKind, x: f64, z: f64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(p) = inner.players.get_mut(session) {
            p.kind = kind;
            p.pos = (x, z);
            p.y = 0.0;
            p.vy = 0.0;
        }
    }
}

fn err(code: &str, message: &str) -> ServerMsg {
    ServerMsg::Error {
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn new_session_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Drive the tick loop forever (spawned once at boot).
pub async fn tick_loop(app: AppState) {
    let hz = app.world.tick_hz.max(1);
    let dt = 1.0 / hz as f64;
    let mut interval = tokio::time::interval(std::time::Duration::from_secs_f64(dt));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        app.tick(dt);
    }
}

/// Per-connection websocket pump: register the session, send hello, then
/// shuttle messages both ways until the socket closes.
pub async fn client_loop(socket: WebSocket, app: AppState) {
    let (outbox_tx, mut outbox_rx) = mpsc::channel::<ServerMsg>(OUTBOX);
    let (session, hello) = app.connect(outbox_tx);
    let (mut ws_tx, mut ws_rx) = socket.split();

    if send_msg(&mut ws_tx, &hello).await.is_err() {
        app.disconnect(&session);
        return;
    }

    loop {
        tokio::select! {
            outbound = outbox_rx.recv() => {
                match outbound {
                    Some(msg) => {
                        if send_msg(&mut ws_tx, &msg).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            inbound = ws_rx.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMsg>(&text) {
                            Ok(msg) => app.handle_client_msg(&session, msg),
                            Err(e) => {
                                debug!(%session, "bad client message: {e}");
                                let _ = send_msg(
                                    &mut ws_tx,
                                    &err("bad-message", "could not parse that"),
                                )
                                .await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {} // ping/pong/binary: ignore
                    Some(Err(e)) => {
                        debug!(%session, "ws error: {e}");
                        break;
                    }
                }
            }
        }
    }

    app.disconnect(&session);
}

async fn send_msg(
    ws_tx: &mut (impl Sink<Message, Error = axum::Error> + Unpin),
    msg: &ServerMsg,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(msg).expect("ServerMsg always serializes");
    ws_tx.send(Message::Text(json)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::default_world;
    use std::collections::BTreeMap;

    /// Legacy-format vault (bare array = chest.jade's stock); also proves
    /// the Phase-0 file format keeps working end to end.
    fn test_game(vault_tokens: &[&str]) -> (tempfile::TempDir, AppState) {
        test_game_raw(&serde_json::to_string(&vault_tokens).unwrap())
    }

    /// Map-format vault for multi-chest tests.
    fn test_game_map(stock: &[(&str, &[&str])]) -> (tempfile::TempDir, AppState) {
        let map: BTreeMap<String, Vec<String>> = stock
            .iter()
            .map(|(chest, tokens)| {
                (
                    chest.to_string(),
                    tokens.iter().map(|t| t.to_string()).collect(),
                )
            })
            .collect();
        test_game_raw(&serde_json::to_string(&map).unwrap())
    }

    fn test_game_raw(vault_json: &str) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let vault_path = dir.path().join("vault.json");
        std::fs::write(&vault_path, vault_json).unwrap();
        let world = default_world(10, 50, 200);
        let config = GameConfig {
            mint_url: "http://127.0.0.1:28338".into(),
            unit: "pop_test".into(),
            accepted_units: vec!["pop_test".into()],
            prices: BTreeMap::from([
                ("spawn".to_string(), 10),
                ("court.jade".to_string(), 50),
                ("court.crimson".to_string(), 200),
            ]),
            mode: crate::protocol::Mode::Mock,
        };
        (dir, Game::new(world, config, Vault::new(vault_path)))
    }

    fn connect(app: &AppState) -> (String, mpsc::Receiver<ServerMsg>) {
        let (tx, rx) = mpsc::channel(OUTBOX);
        let (id, hello) = app.connect(tx);
        assert!(matches!(hello, ServerMsg::Hello { .. }));
        (id, rx)
    }

    fn drain(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<ServerMsg> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(m);
        }
        out
    }

    /// Walk a session straight to a coordinate (test-only teleport that still
    /// respects nothing; used to position actors for interaction tests).
    fn teleport(app: &AppState, session: &str, x: f64, z: f64) {
        let mut inner = app.inner.lock().unwrap();
        inner.players.get_mut(session).unwrap().pos = (x, z);
    }

    #[test]
    fn spawn_grant_flips_ghost_to_body_at_spawn_point() {
        let (_dir, app) = test_game(&[]);
        let (id, mut rx) = connect(&app);
        assert_eq!(app.grant(&id, "spawn"), Ok(()));
        let inner = app.inner.lock().unwrap();
        let p = &inner.players[&id];
        assert_eq!(p.kind, AvatarKind::Body);
        assert_eq!(p.pos, (app.world.spawn_body.x, app.world.spawn_body.z));
        drop(inner);
        let msgs = drain(&mut rx);
        assert!(msgs
            .iter()
            .any(|m| matches!(m, ServerMsg::Entitlement { gate } if gate == "spawn")));
    }

    #[test]
    fn grant_unknown_session_is_an_error() {
        let (_dir, app) = test_game(&[]);
        assert_eq!(app.grant("nope", "spawn"), Err(GrantError::UnknownSession));
    }

    #[test]
    fn entitlements_are_session_bound() {
        let (_dir, app) = test_game(&[]);
        let (a, _rxa) = connect(&app);
        let (b, _rxb) = connect(&app);
        app.grant(&a, "court.jade").unwrap();
        assert!(app.is_entitled(&a, "court.jade"));
        assert!(!app.is_entitled(&b, "court.jade"), "entitlement leaked across sessions");
        // …and die with the session.
        app.disconnect(&a);
        assert!(!app.is_entitled(&a, "court.jade"));
    }

    #[test]
    fn chest_claim_happy_path_then_double_claim_rejected() {
        let (_dir, app) = test_game(&["cashuBprize-one", "cashuBprize-two"]);
        let (a, mut rxa) = connect(&app);
        app.grant(&a, "spawn").unwrap();
        app.grant(&a, "court.jade").unwrap();
        teleport(&app, &a, -14.0, 20.0); // at the chest
        drain(&mut rxa);

        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.jade".into() });
        let msgs = drain(&mut rxa);
        let prize = msgs.iter().find_map(|m| match m {
            ServerMsg::Prize { token, .. } => Some(token.clone()),
            _ => None,
        });
        assert_eq!(prize.as_deref(), Some("cashuBprize-one"));
        // Vault was debited (one token left for a future restock).
        assert_eq!(app.vault.stock().unwrap(), 1);

        // Same session claims again -> rejected.
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.jade".into() });
        let msgs = drain(&mut rxa);
        assert!(msgs.iter().any(
            |m| matches!(m, ServerMsg::Error { code, .. } if code == "chest-claimed")
        ));

        // A second (fully entitled) session is also rejected: one-shot stock.
        let (b, mut rxb) = connect(&app);
        app.grant(&b, "spawn").unwrap();
        app.grant(&b, "court.jade").unwrap();
        teleport(&app, &b, -14.0, 20.0);
        drain(&mut rxb);
        app.handle_client_msg(&b, ClientMsg::Interact { target: "chest.jade".into() });
        let msgs = drain(&mut rxb);
        assert!(msgs.iter().any(
            |m| matches!(m, ServerMsg::Error { code, .. } if code == "chest-claimed")
        ));
        assert_eq!(app.vault.stock().unwrap(), 1, "rejected claim must not debit the vault");
    }

    #[test]
    fn ghost_and_distance_and_room_guards() {
        let (_dir, app) = test_game(&["cashuBprize"]);
        let (a, mut rxa) = connect(&app);

        // Ghost: refused.
        teleport(&app, &a, -14.0, 20.0);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.jade".into() });
        assert!(drain(&mut rxa)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "not-a-body")));

        // Body but in the street: wrong room.
        app.grant(&a, "spawn").unwrap();
        drain(&mut rxa);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.jade".into() });
        assert!(drain(&mut rxa)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "wrong-room")));

        // In the right court but far from the chest: out of range.
        app.grant(&a, "court.jade").unwrap();
        teleport(&app, &a, -21.0, 23.0);
        drain(&mut rxa);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.jade".into() });
        assert!(drain(&mut rxa)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "out-of-range")));

        // Nothing was handed out along the way.
        assert_eq!(app.vault.stock().unwrap(), 1);
    }

    #[test]
    fn tick_moves_players_and_snapshots() {
        let (_dir, app) = test_game(&[]);
        let (a, mut rxa) = connect(&app);
        app.handle_client_msg(&a, ClientMsg::Move { x: 1.0, z: 0.0 });
        app.tick(0.1);
        let pos = app.position_of(&a).unwrap();
        assert!(pos.x > app.world.spawn_ghost.x, "intent did not move the ghost");
        let msgs = drain(&mut rxa);
        assert!(msgs.iter().any(|m| matches!(m, ServerMsg::State { .. })));
    }

    #[test]
    fn non_finite_intent_is_neutralized() {
        let (_dir, app) = test_game(&[]);
        let (a, _rxa) = connect(&app);
        app.handle_client_msg(&a, ClientMsg::Move { x: f64::NAN, z: f64::INFINITY });
        app.tick(0.1);
        let pos = app.position_of(&a).unwrap();
        assert!(pos.x.is_finite() && pos.z.is_finite());
    }

    /* ----------------------------- Phase 1a ------------------------------ */

    fn y_of(app: &AppState, session: &str) -> f64 {
        app.inner.lock().unwrap().players[session].y
    }

    #[test]
    fn empty_chests_render_already_looted_from_boot() {
        // Stock only the alley chest: it is live, everything else is looted.
        let (_dir, app) = test_game_map(&[("chest.alley", &["cashuBalley"])]);
        let inner = app.inner.lock().unwrap();
        assert!(!inner.chest_claimed["chest.alley"]);
        assert!(inner.chest_claimed["chest.jade"]);
        assert!(inner.chest_claimed["chest.rooftop"]);
        assert!(inner.chest_claimed["chest.stall"]);
    }

    #[test]
    fn legacy_vault_array_still_feeds_chest_jade() {
        let (_dir, app) = test_game(&["cashuBlegacy"]);
        let inner = app.inner.lock().unwrap();
        assert!(!inner.chest_claimed["chest.jade"]);
        assert!(inner.chest_claimed["chest.rooftop"]);
    }

    #[test]
    fn body_jumps_rise_and_land_ghosts_do_not() {
        let (_dir, app) = test_game(&[]);
        let (ghost, _rx1) = connect(&app);
        let (body, _rx2) = connect(&app);
        app.grant(&body, "spawn").unwrap();

        app.handle_client_msg(&ghost, ClientMsg::Jump);
        app.handle_client_msg(&body, ClientMsg::Jump);
        app.tick(1.0 / 15.0);
        assert_eq!(y_of(&app, &ghost), 0.0, "ghosts must not jump");
        assert!(y_of(&app, &body) > 0.0, "body jump must rise");

        // Mid-air jumps are ignored (no double jump).
        let mid_air_y = y_of(&app, &body);
        let mid_air_vy = app.inner.lock().unwrap().players[&body].vy;
        app.handle_client_msg(&body, ClientMsg::Jump);
        assert_eq!(app.inner.lock().unwrap().players[&body].vy, mid_air_vy);
        assert!(mid_air_y > 0.0);

        // It comes back down and stays grounded.
        for _ in 0..30 {
            app.tick(1.0 / 15.0);
        }
        assert_eq!(y_of(&app, &body), 0.0, "jump must land");
    }

    #[test]
    fn rooftop_chest_needs_the_jump() {
        let (_dir, app) = test_game_map(&[("chest.rooftop", &["cashuBroof"])]);
        let (a, mut rxa) = connect(&app);
        app.grant(&a, "spawn").unwrap();
        // Stand on the street right under the awning lip.
        teleport(&app, &a, 9.0, -7.4);
        drain(&mut rxa);

        // From the ground: out of (3D) range.
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.rooftop".into() });
        assert!(drain(&mut rxa)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "out-of-range")));

        // Jump, ride the arc to the apex, claim mid-air.
        app.handle_client_msg(&a, ClientMsg::Jump);
        let dt = 1.0 / 15.0;
        let mut best_y = 0.0f64;
        let mut claimed = false;
        for _ in 0..20 {
            app.tick(dt);
            let y = y_of(&app, &a);
            best_y = best_y.max(y);
            if y > 0.9 && !claimed {
                app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.rooftop".into() });
                claimed = true;
            }
        }
        assert!(claimed, "never reached claim height; best apex {best_y}");
        let msgs = drain(&mut rxa);
        assert!(
            msgs.iter().any(|m| matches!(
                m,
                ServerMsg::Prize { chest, token } if chest == "chest.rooftop" && token == "cashuBroof"
            )),
            "no prize after the mid-air claim (apex {best_y}); got {msgs:?}"
        );
    }

    #[test]
    fn street_chest_claims_from_the_street_but_not_from_a_court() {
        let (_dir, app) = test_game_map(&[("chest.stall", &["cashuBstall"])]);
        let (a, mut rxa) = connect(&app);
        app.grant(&a, "spawn").unwrap();
        app.grant(&a, "court.jade").unwrap();

        // From inside a court: wrong room (it is a STREET chest).
        teleport(&app, &a, -14.0, 12.0);
        drain(&mut rxa);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.stall".into() });
        assert!(drain(&mut rxa)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "wrong-room")));

        // From the hidden gap behind the trinket stall: prize.
        teleport(&app, &a, -5.0, -9.4);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.stall".into() });
        let msgs = drain(&mut rxa);
        assert!(msgs.iter().any(
            |m| matches!(m, ServerMsg::Prize { chest, .. } if chest == "chest.stall")
        ));
    }

    #[test]
    fn chat_broadcasts_to_everyone_including_ghosts() {
        let (_dir, app) = test_game(&[]);
        let (speaker, mut rx_speaker) = connect(&app);
        let (_ghost, mut rx_ghost) = connect(&app);
        app.grant(&speaker, "spawn").unwrap();
        app.handle_client_msg(&speaker, ClientMsg::Join { name: "noodle-max".into() });
        drain(&mut rx_speaker);
        drain(&mut rx_ghost);

        app.handle_client_msg(&speaker, ClientMsg::Chat { text: "  fresh skewers!  ".into() });
        for rx in [&mut rx_speaker, &mut rx_ghost] {
            let msgs = drain(rx);
            assert!(
                msgs.iter().any(|m| matches!(
                    m,
                    ServerMsg::Chat { from, name, text }
                        if from == &speaker && name == "noodle-max" && text == "fresh skewers!"
                )),
                "chat missing: {msgs:?}"
            );
        }
    }

    #[test]
    fn ghosts_cannot_speak() {
        let (_dir, app) = test_game(&[]);
        let (ghost, mut rx) = connect(&app);
        drain(&mut rx);
        app.handle_client_msg(&ghost, ClientMsg::Chat { text: "boo".into() });
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(
            |m| matches!(m, ServerMsg::Error { code, .. } if code == "not-a-body")
        ));
        assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::Chat { .. })));
    }

    #[test]
    fn chat_is_rate_limited_and_clipped() {
        let (_dir, app) = test_game(&[]);
        let (a, mut rxa) = connect(&app);
        app.grant(&a, "spawn").unwrap();
        drain(&mut rxa);

        // Oversized text is clipped to MAX_CHAT chars, not rejected.
        let long = "x".repeat(MAX_CHAT * 2);
        app.handle_client_msg(&a, ClientMsg::Chat { text: long });
        let msgs = drain(&mut rxa);
        let relayed = msgs.iter().find_map(|m| match m {
            ServerMsg::Chat { text, .. } => Some(text.clone()),
            _ => None,
        });
        assert_eq!(relayed.map(|t| t.chars().count()), Some(MAX_CHAT));

        // An immediate second message trips the cooldown…
        app.handle_client_msg(&a, ClientMsg::Chat { text: "again".into() });
        assert!(drain(&mut rxa)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "chat-rate")));

        // …and a rejected message must NOT reset the cooldown clock; once the
        // window passes, speech resumes.
        app.inner.lock().unwrap().players.get_mut(&a).unwrap().last_chat =
            Some(std::time::Instant::now() - CHAT_COOLDOWN * 2);
        app.handle_client_msg(&a, ClientMsg::Chat { text: "later".into() });
        assert!(drain(&mut rxa)
            .iter()
            .any(|m| matches!(m, ServerMsg::Chat { text, .. } if text == "later")));
    }

    #[test]
    fn empty_or_control_only_chat_is_dropped_silently() {
        let (_dir, app) = test_game(&[]);
        let (a, mut rxa) = connect(&app);
        app.grant(&a, "spawn").unwrap();
        drain(&mut rxa);
        app.handle_client_msg(&a, ClientMsg::Chat { text: " \u{0007}\n\t ".into() });
        let msgs = drain(&mut rxa);
        assert!(
            !msgs.iter().any(|m| matches!(m, ServerMsg::Chat { .. } | ServerMsg::Error { .. })),
            "blank chat should be a silent no-op: {msgs:?}"
        );
    }

    /* ------------------------------ Phase 1b ------------------------------ */

    /// Stand a fully-spawned body at the riddle lantern in the jade court.
    fn body_at_riddle(app: &AppState) -> (String, mpsc::Receiver<ServerMsg>) {
        let (a, mut rx) = connect(app);
        app.grant(&a, "spawn").unwrap();
        app.grant(&a, "court.jade").unwrap();
        let booth = app.world.booths.iter().find(|b| b.kind == "riddle").unwrap();
        teleport(app, &a, booth.x, booth.z);
        drain(&mut rx);
        (a, rx)
    }

    #[test]
    fn the_world_ships_three_booths_in_their_regions() {
        let (_dir, app) = test_game(&[]);
        let kinds: Vec<&str> = app.world.booths.iter().map(|b| b.kind.as_str()).collect();
        assert!(kinds.contains(&"riddle"));
        assert!(kinds.contains(&"gacha"));
        assert!(kinds.contains(&"bell"));
        let riddle = app.world.booths.iter().find(|b| b.kind == "riddle").unwrap();
        assert_eq!(riddle.court, "jade");
        assert_eq!(riddle.price, 0, "the riddle is free");
        let bell = app.world.booths.iter().find(|b| b.kind == "bell").unwrap();
        assert_eq!(bell.court, "street");
    }

    #[test]
    fn interacting_with_the_riddle_sends_the_current_prompt() {
        let (_dir, app) = test_game_map(&[("booth.riddle", &["cashuBriddle"])]);
        let (a, mut rx) = body_at_riddle(&app);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "booth.riddle".into() });
        let msgs = drain(&mut rx);
        let prompt = msgs.iter().find_map(|m| match m {
            ServerMsg::Riddle { booth, prompt } if booth == "booth.riddle" => Some(prompt.clone()),
            _ => None,
        });
        assert_eq!(prompt.as_deref(), Some(crate::booth::riddle_prompt(0)));
    }

    #[test]
    fn riddle_ghost_and_room_guards() {
        let (_dir, app) = test_game_map(&[("booth.riddle", &["cashuBriddle"])]);
        // A ghost standing right at the booth cannot engage it.
        let (g, mut rxg) = connect(&app);
        let booth = app.world.booths.iter().find(|b| b.kind == "riddle").unwrap();
        teleport(&app, &g, booth.x, booth.z);
        drain(&mut rxg);
        app.handle_client_msg(&g, ClientMsg::Answer { booth: "booth.riddle".into(), text: "echo".into() });
        assert!(drain(&mut rxg)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "not-a-body")));

        // A body OUTSIDE the jade court (in the street) cannot answer it.
        let (b, mut rxb) = connect(&app);
        app.grant(&b, "spawn").unwrap();
        teleport(&app, &b, 0.0, 0.0);
        drain(&mut rxb);
        app.handle_client_msg(&b, ClientMsg::Answer { booth: "booth.riddle".into(), text: "echo".into() });
        assert!(drain(&mut rxb)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "wrong-room")));
    }

    #[test]
    fn riddle_correct_answer_wins_a_prize_and_rotates() {
        let (_dir, app) = test_game_map(&[("booth.riddle", &["cashuBriddleone", "cashuBriddletwo"])]);
        let (a, mut rx) = body_at_riddle(&app);
        // The booth opens on the riddle at index 0 ("echo").
        assert_eq!(app.inner.lock().unwrap().riddle_index, 0);
        assert!(crate::booth::riddle_is_correct(0, "an echo"));

        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "An Echo!".into() });
        let msgs = drain(&mut rx);
        let prize = msgs.iter().find_map(|m| match m {
            ServerMsg::Prize { chest, token } if chest == "booth.riddle" => Some(token.clone()),
            _ => None,
        });
        assert_eq!(prize.as_deref(), Some("cashuBriddleone"), "first prize handed out");
        // The riddle rotated to index 1, and the booth vault was debited.
        assert_eq!(app.inner.lock().unwrap().riddle_index, 1);
        assert_eq!(app.vault.stock_for("booth.riddle").unwrap(), 1);
    }

    #[test]
    fn riddle_wrong_answer_is_flavor_and_keeps_the_riddle() {
        let (_dir, app) = test_game_map(&[("booth.riddle", &["cashuBriddle"])]);
        let (a, mut rx) = body_at_riddle(&app);
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "a candle".into() });
        let msgs = drain(&mut rx);
        assert!(msgs
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "wrong-answer")));
        assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::Prize { .. })));
        assert_eq!(app.inner.lock().unwrap().riddle_index, 0, "a wrong guess never rotates");
        assert_eq!(app.vault.stock_for("booth.riddle").unwrap(), 1);
    }

    #[test]
    fn riddle_is_rate_limited_one_guess_per_window() {
        let (_dir, app) = test_game_map(&[("booth.riddle", &["cashuBriddle"])]);
        let (a, mut rx) = body_at_riddle(&app);
        // First guess (wrong) is accepted and consumes the window.
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "nope".into() });
        assert!(drain(&mut rx)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "wrong-answer")));
        // An immediate second guess trips the cooldown (even the CORRECT one).
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "echo".into() });
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "guess-rate")));
        assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::Prize { .. })), "rate-limited guess wins nothing");
        // A rejected guess must NOT reset the clock: once the window passes, it solves.
        app.inner.lock().unwrap().players.get_mut(&a).unwrap().last_guess =
            Some(std::time::Instant::now() - GUESS_COOLDOWN * 2);
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "echo".into() });
        assert!(drain(&mut rx)
            .iter()
            .any(|m| matches!(m, ServerMsg::Prize { chest, .. } if chest == "booth.riddle")));
    }

    #[test]
    fn riddle_one_win_per_session() {
        // Two tokens stocked, but one session may win only once.
        let (_dir, app) = test_game_map(&[("booth.riddle", &["cashuBone", "cashuBtwo"])]);
        let (a, mut rx) = body_at_riddle(&app);
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "echo".into() });
        assert!(drain(&mut rx).iter().any(|m| matches!(m, ServerMsg::Prize { .. })));
        // The riddle rotated to index 1 ("footsteps"); answer it past the window.
        app.inner.lock().unwrap().players.get_mut(&a).unwrap().last_guess =
            Some(std::time::Instant::now() - GUESS_COOLDOWN * 2);
        assert_eq!(app.inner.lock().unwrap().riddle_index, 1);
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "footsteps".into() });
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "already-won")));
        assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::Prize { .. })));
        assert_eq!(app.vault.stock_for("booth.riddle").unwrap(), 1, "second token never handed out");
    }

    #[test]
    fn riddle_solved_with_empty_stock_still_rotates_but_reports_empty() {
        let (_dir, app) = test_game_map(&[("booth.gacha", &["x"])]); // riddle stock EMPTY
        let (a, mut rx) = body_at_riddle(&app);
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.riddle".into(), text: "echo".into() });
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "vault-empty")));
        assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::Prize { .. })));
        assert_eq!(app.inner.lock().unwrap().riddle_index, 1, "solving rotates even with no prize");
    }

    #[test]
    fn answering_a_non_riddle_booth_is_rejected() {
        let (_dir, app) = test_game(&[]);
        let (a, mut rx) = connect(&app);
        app.grant(&a, "spawn").unwrap();
        drain(&mut rx);
        app.handle_client_msg(&a, ClientMsg::Answer { booth: "booth.gacha".into(), text: "x".into() });
        assert!(drain(&mut rx)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "no-riddle")));
    }

    /// THE QUIRK FIX: chest.stall must NOT be claimable through the trinket
    /// stall wall. A body at the stall's FRONT counter (street side) is within
    /// the 3.0 interact sphere of the chest behind it, but the footprint sits
    /// between them; line of sight blocks the claim. Reaching it requires
    /// walking around to the hidden gap behind (the existing happy-path test).
    #[test]
    fn chest_stall_is_not_claimable_through_the_stall_wall() {
        let (_dir, app) = test_game_map(&[("chest.stall", &["cashuBstall"])]);
        let (a, mut rx) = connect(&app);
        app.grant(&a, "spawn").unwrap();

        let chest = app.world.chests.iter().find(|c| c.id == "chest.stall").unwrap();
        // Stand on the street side of the trinket stall, in front of the chest.
        // Footprint is x[-7,-3], z[-9,-7]; the chest is at z=-9.5 behind it.
        // From z=-6.6 the straight-line distance is < 3.0 (the old bug) but the
        // footprint is on the segment.
        teleport(&app, &a, chest.x, -6.6);
        let horiz = ((chest.x - chest.x).powi(2) + (-6.6f64 - chest.z).powi(2)).sqrt();
        assert!(horiz < 3.0, "the test must stand inside the OLD sphere (was {horiz})");
        drain(&mut rx);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.stall".into() });
        let msgs = drain(&mut rx);
        assert!(
            msgs.iter().any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "out-of-range")),
            "must be blocked through the wall: {msgs:?}"
        );
        assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::Prize { .. })), "no prize through the wall");
        assert_eq!(app.vault.stock_for("chest.stall").unwrap(), 1, "vault not debited");

        // …but from the hidden gap BEHIND the stall (clear line of sight) it claims.
        teleport(&app, &a, -5.0, -9.4);
        app.handle_client_msg(&a, ClientMsg::Interact { target: "chest.stall".into() });
        assert!(drain(&mut rx)
            .iter()
            .any(|m| matches!(m, ServerMsg::Prize { chest, .. } if chest == "chest.stall")));
    }
}
