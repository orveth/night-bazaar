/**
 * Night Bazaar wire protocol, v0 (Phase 0 spike).
 *
 * THE SEAM: this file is the single TypeScript source of truth for every
 * message that crosses the game websocket plus the small HTTP config surface.
 * The Rust mirror lives in `server/src/protocol.rs`; both sides round-trip the
 * shared fixtures in `fixtures/messages.json` in their test suites, so a field
 * rename on one side fails the other side's tests.
 *
 * Payments NEVER ride the websocket. Gates are plain HTTP 402 endpoints behind
 * the pops-core-verify middleware (`POST /spawn`, `POST /enter/:court` with the
 * ws session id in the `x-bazaar-session` header); the ws layer only carries
 * the RESULT (an `entitlement` message) once a gate endpoint reports paid.
 */

/** Gate identifiers — the (session, gate) entitlement key space. */
export type GateId = "spawn" | "court.jade" | "court.crimson";

/** Axis-aligned rectangle on the ground plane (y = 0). */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * A door gap in a court's street-facing wall (the wall on the court's `minZ`
 * edge). Passage through the wall is legal only for `x` within `[x1, x2]`,
 * and only for an entitled body.
 */
export interface Door {
  x1: number;
  x2: number;
}

/** A priced court: a box room off the street. */
export interface CourtSpec {
  id: string; // "jade" | "crimson"
  gate: GateId; // "court.jade" | "court.crimson"
  price: number; // pops
  bounds: Rect;
  door: Door;
}

/**
 * A treasure chest. Claiming hands over a vault token. `court` is the owning
 * court id, or `"street"` for hidden finds out on the free street (Phase 1a,
 * additive). `y` is height off the ground (rooftop finds need the jump).
 */
export interface ChestSpec {
  id: string; // "chest.jade"
  court: string; // owning court id | "street"
  x: number;
  y: number;
  z: number;
}

/**
 * A market stall (Phase 1a, additive). Visuals are client-side (seeded by
 * `id` + `kind`); the `footprint` is the SERVER-authoritative occluder — the
 * client must render blocking geometry that covers it, and the server blocks
 * movement into it. `rot` is the facing (radians around y) for visuals only.
 */
export interface StallSpec {
  id: string;
  /** Visual archetype: "noodle" | "fish" | "lantern" | "tea" | "trinket" | "skewer" | "potion" | "fruit" | "dumpling" | "incense" | "crates" | … */
  kind: string;
  x: number;
  z: number;
  rot: number;
  footprint: Rect;
}

/**
 * A playable booth (Phase 1b, additive). The client renders a marker glow +
 * interact prompt at `(x, z)`. `court` is the owning court id or `"street"`.
 * `price` is the per-play cost in pops (0 = free, e.g. the riddle lantern);
 * paid plays POST `/play/:kind` behind the same pops middleware as doors.
 */
export interface BoothSpec {
  id: string; // "booth.riddle" | "booth.gacha" | "booth.bell"
  kind: "riddle" | "gacha" | "bell" | string;
  court: string; // owning court id | "street"
  x: number;
  z: number;
  price: number; // pops per play (0 = free)
}

/** Point on the ground plane. */
export interface Vec2 {
  x: number;
  z: number;
}

/**
 * World geometry + movement constants. Server-authoritative: the server sends
 * this in `hello` and the client renders FROM it (no client-side copy of the
 * map that could drift).
 */
export interface World {
  street: Rect;
  courts: CourtSpec[];
  chests: ChestSpec[];
  /** Market stalls (Phase 1a, additive): footprints double as occluders. */
  stalls: StallSpec[];
  /** Playable booths (Phase 1b, additive). */
  booths: BoothSpec[];
  spawnGhost: Vec2;
  spawnBody: Vec2;
  /** Movement speed, units/second (server integrates intents at this speed). */
  speed: number;
  /** Server tick rate for state snapshots, Hz. */
  tickHz: number;
}

/** Ghost = free spectator (translucent, gate-blocked). Body = paid spawn. */
export type AvatarKind = "ghost" | "body";

/** One player in a state snapshot. `y` is jump height (Phase 1a, additive). */
export interface PlayerSnapshot {
  id: string;
  name: string;
  kind: AvatarKind;
  x: number;
  y: number;
  z: number;
}

/** One chest in a state snapshot. */
export interface ChestSnapshot {
  id: string;
  claimed: boolean;
}

/** Game config surfaced to the client (`hello` + `GET /api/config`). */
export interface GameConfig {
  /** Mint the gates redeem against (the client wallet swaps here too). */
  mintUrl: string;
  /**
   * The unit a FRESH player should mint into: the NEWEST currently-valid
   * `pop_<ts>` unit (latest `final_expiry`), read from the mint's `/v1/keysets`
   * at server boot and refreshed periodically — never hardcoded anywhere.
   */
  unit: string;
  /**
   * Every currently-valid `pop_<ts>` unit the server accepts a payment in.
   * Units rotate and OVERLAP, so an older-but-unexpired unit is still honored;
   * the client declares which one it holds on a gate request (`?unit=`). Empty
   * / omitted on legacy or mock configs.
   */
  acceptedUnits?: string[];
  /** Price per gate, in pops. */
  prices: Record<string, number>;
  /** "live" = pops middleware enforced; "mock" = free gates (dev/smoke only). */
  mode: "live" | "mock";
}

/* ------------------------------ client → server --------------------------- */

export type ClientMsg =
  /** Set the display name (once, after hello). */
  | { type: "join"; name: string }
  /**
   * Movement intent: a direction vector, clamped server-side to length <= 1.
   * Applied each tick until replaced. {x:0,z:0} stops.
   */
  | { type: "move"; x: number; z: number }
  /** Jump (Phase 1a, additive): bodies only, only from the ground. */
  | { type: "jump" }
  /**
   * Say something (Phase 1a, additive): bodies only, server clips to 200
   * chars and rate-limits to ~1/sec ("chat-rate" error beyond that).
   */
  | { type: "chat"; text: string }
  /** Interact with a world object (v0: chest claim, e.g. "chest.jade"; Phase
   * 1b: engaging a booth, e.g. the riddle lantern "booth.riddle"). */
  | { type: "interact"; target: string }
  /** Answer a riddle booth (Phase 1b, additive): `booth` is the booth you are
   * standing at, `text` your typed guess. */
  | { type: "answer"; booth: string; text: string };

/* ------------------------------ server → client --------------------------- */

export type ServerMsg =
  /** First message on connect: your session id + the world + config. */
  | { type: "hello"; session: string; world: World; config: GameConfig }
  /** Full snapshot, tickHz times a second (player counts are tiny in v0). */
  | {
      type: "state";
      tick: number;
      players: PlayerSnapshot[];
      chests: ChestSnapshot[];
    }
  /**
   * A gate endpoint reported this session paid: the entitlement is now held.
   * For "spawn" the avatar also flips ghost → body at the body spawn point.
   */
  | { type: "entitlement"; gate: GateId }
  /** Chest claim payout (private to the claiming session). Real ecash. */
  | { type: "prize"; chest: string; token: string }
  /**
   * Chat relay (Phase 1a, additive): broadcast to everyone in the bazaar
   * (ghosts read too); `from` is the speaker's session id so clients can
   * float the bubble over the right body.
   */
  | { type: "chat"; from: string; name: string; text: string }
  /**
   * A riddle booth's current prompt (Phase 1b, additive), sent to the
   * interacting session when it engages the lantern.
   */
  | { type: "riddle"; booth: string; prompt: string }
  /**
   * A bell rang nearby (Phase 1b, additive): broadcast so others hear the
   * chime. `from` is the ringer's session id; `hit` whether they timed it.
   */
  | { type: "bellring"; booth: string; from: string; hit: boolean }
  /** Recoverable game-level errors (chest-claimed, not-a-body, …). */
  | { type: "error"; code: string; message: string };

/** Error codes the server emits in `error` messages. */
export type ErrorCode =
  | "bad-message" // unparseable client message
  | "not-a-body" // ghosts cannot interact or speak
  | "wrong-room" // not inside the chest's/booth's court
  | "out-of-range" // too far from the chest/booth
  | "chest-claimed" // someone (maybe you) already claimed it
  | "vault-empty" // chest/booth unclaimed but the vault has no token
  | "unknown-target" // interact target does not exist
  | "chat-rate" // talking faster than ~1 message/sec
  | "guess-rate" // answering a riddle faster than the allowed cadence
  | "already-won" // already won this booth this session
  | "no-riddle" // answered a booth that is not an engaged riddle
  | "wrong-answer"; // riddle guess was wrong (flavor + retry)

/* ------------------------------ paid plays (HTTP) ------------------------- */

/**
 * Paid plays POST `/play/:kind` behind the pops middleware (price per request).
 * The paid response carries the play RESULT directly (the request IS the play);
 * the ws only carries state others can see (a bell ring chime). These are the
 * 200 bodies; failures are RFC-9457 problem+json from the middleware/handler.
 */

/** `POST /play/gacha` 200 body. Deterministic every-Nth-wins. */
export interface GachaResult {
  booth: string; // "booth.gacha"
  play: "gacha";
  /** Did this pull win? */
  win: boolean;
  /** Cosmetic fortune line. */
  fortune: string;
  /** 1-based position in the current N-cycle (a "pity" hint). */
  pity: number;
  /** The prize token, present only on a win with stock left. */
  token?: string;
  /** Set when win is true but the booth's prize stock was empty. */
  soldOut?: boolean;
  /** Pops actually charged for this play (echo of the price). */
  paid: number;
}

/** `POST /play/bell` 200 body: the play handle the client renders from. */
export interface BellPlay {
  booth: string; // "booth.bell"
  play: "bell";
  /** Opaque id for this play; echo it to `/play/bell/press`. */
  playId: string;
  /** Visual seed for the pendulum's starting phase (client render only). */
  seed: number;
  /** Pendulum period in ms (a full swing). */
  periodMs: number;
  /** Tolerance window in ms around a sweet spot (for the client's UI hint). */
  toleranceMs: number;
  /** Milliseconds until this play expires (server clock authoritative). */
  expiresInMs: number;
  /** Pops actually charged for this play. */
  paid: number;
}

/** `POST /play/bell/press` 200 body (free, session-checked). */
export interface BellPressResult {
  booth: string; // "booth.bell"
  play: "bell";
  /** Within tolerance of a sweet spot? */
  hit: boolean;
  /** Absolute offset (ms) from the nearest sweet spot (for feedback). */
  offsetMs: number;
  /** The prize token, present only on a hit with stock left. */
  token?: string;
  /** Set when hit is true but the booth's prize stock was empty. */
  soldOut?: boolean;
}

/** Header carrying the ws session id on gate POSTs. */
export const SESSION_HEADER = "x-bazaar-session";
