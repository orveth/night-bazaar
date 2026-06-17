/**
 * Night Bazaar client entry: glue net + scene + HUD + payer + ambience.
 *
 * Free ghost on connect; [B] pays the spawn gate; walking near a court door
 * shows a pay prompt ([E]); near a chest (as a body, in the right place),
 * [E] claims; rooftop finds need [Space] mid-air. Enter/T talks (bodies).
 * All payments are plain HTTP through payer.ts; the ws only delivers the
 * resulting entitlement. PAYMENT SEAMS UNTOUCHED in Phase 1a.
 */

import "./webgpu-shim.ts"; // MUST come first: three.webgpu reads GPU* enums at module scope
import type {
  BellPlay,
  BellPressResult,
  BoothSpec,
  GachaResult,
  GameConfig,
  World,
} from "../../protocol/protocol.ts";
import { Net } from "./net.ts";
import { Scene3D } from "./world3d.ts";
import { Hud } from "./hud.ts";
import { BoothUI } from "./booths.ts";
import { payGate } from "./payer.ts";
import {
  buildPopWallet,
  buildProofStateChecker,
  getBalance,
  importTokenChecked,
  InventoryWriteError,
  onInventoryChanged,
  reclaimPendingPresentations,
} from "./wallet.ts";
import { BazaarAudio } from "./audio.ts";
import { FakeCrowd } from "./fakecrowd.ts";
import type { PopWallet } from "@mpp-jams/fetch-with-pop";

let scene: Scene3D | null = null;
let world: World | null = null;
let config: GameConfig | null = null;
let wallet: PopWallet | null = null;
let session: string | null = null;
let kind: "ghost" | "body" = "ghost";
let crowd: FakeCrowd | null = null;
const entitlements = new Set<string>();
const chestsClaimed = new Map<string, boolean>();
let paying = false;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud")!;
const audio = new BazaarAudio();

const hud = new Hud(hudRoot, {
  onImport(token) {
    void doImport(token);
  },
  onSetName(name) {
    net.join(name);
  },
  onChat(text) {
    net.chat(text);
  },
});
hud.setKind("ghost");

const booths = new BoothUI(hudRoot, {
  onAnswer(booth, text) {
    net.answer(booth, text);
  },
  onBellPress() {
    void pressBell();
  },
});
// Debug/screenshot handle (mirrors __scene3d): lets a harness render a booth
// UI deterministically. Never used by gameplay.
(window as unknown as Record<string, unknown>).__booths = booths;

const net = new Net({
  onHello(s, w, c) {
    session = s;
    world = w;
    config = c;
    wallet = c.mode === "live" ? buildPopWallet(c.mintUrl, c.unit) : mockWallet();
    hud.setMode(c.mode);
    // F6 recovery: a prior session may have produced a token it never got a 200
    // for (a crash/close mid-present). Re-import any stranded pending tokens into
    // spendable inventory on startup — they are unspent + fully recoverable.
    if (c.mode === "live") {
      const reclaimed = reclaimPendingPresentations();
      if (reclaimed > 0) {
        hud.status(`recovered ${reclaimed} ${c.unit} from an interrupted payment`);
      }
    }
    void Scene3D.create(canvas, w).then((created) => {
      scene = created;
      scene.setSelf(s);
      const n = Number(new URLSearchParams(location.search).get("crowd") ?? "0");
      if (n > 0) crowd = new FakeCrowd(scene, w, Math.min(12, n));
      hud.status(
        `connected (${scene.backendName}) — you are a ghost. WASD floats, [B] buys a body, [M] mutes.`,
      );
    });
    refreshBalance();
  },
  onState(msg) {
    if (!scene) return;
    scene.applySnapshot(msg.players, msg.chests);
    for (const c of msg.chests) chestsClaimed.set(c.id, c.claimed);
    const self = msg.players.find((p) => p.id === session);
    if (self && self.kind !== kind) {
      kind = self.kind;
      hud.setKind(kind);
    }
  },
  onEntitlement(gate) {
    entitlements.add(gate);
    audio.chime();
    if (gate === "spawn") {
      hud.status("you have a body now. Courts open with [E] at their gates; Enter talks.");
    } else {
      const court = world?.courts.find((c) => c.gate === gate);
      if (court && scene) scene.markCourtOpen(court.id);
      hud.status(`${gate} open — walk in through the gate.`);
    }
  },
  onPrize(chest, token) {
    audio.sparkle();
    hud.showPrize(token);
    // Booth prizes arrive over the same message; close their modal + cheer.
    if (chest === "booth.riddle") booths.closeRiddle();
    const where = chest.startsWith("booth.") ? "you won it" : "chest claimed";
    hud.status(`${where} — the token is yours. Import it into a wallet you trust.`);
  },
  onRiddle(booth, prompt) {
    booths.showRiddle(booth, prompt);
    hud.status("the lantern poses a riddle — type your answer.");
  },
  onBellRing(_booth, from, hit) {
    // Someone rang the bell nearby: a chime everyone hears.
    if (hit) audio.chime();
    else audio.blip();
    if (from !== session) hud.status("a bell rings somewhere in the bazaar…");
  },
  onChat(from, name, text) {
    scene?.showChat(from, text);
    hud.chatLine(name, text);
    if (from !== session) audio.blip();
  },
  onError(code, message) {
    // Riddle wrong-answer is booth flavor, not a top-line error.
    if (code === "wrong-answer") {
      booths.riddleWrong(message);
      return;
    }
    hud.status(`✗ ${code}: ${message}`);
  },
  onClose() {
    hud.status("disconnected — refresh to reconnect (a new session pays gates again).");
  },
});

/** Mock-mode wallet: gates are free server-side; never pays anything. */
function mockWallet(): PopWallet {
  return {
    decodeRequest() {
      throw new Error("mock mode should never see a 402");
    },
    payPopRequest() {
      return Promise.reject(new Error("mock mode should never pay"));
    },
  };
}

function refreshBalance(): void {
  if (!config) return;
  if (config.mode === "mock") {
    hud.setBalance(0, "(mock)");
    return;
  }
  const { balance } = getBalance(config.mintUrl, config.unit);
  hud.setBalance(balance, config.unit);
}

// F5: another tab mutating the shared inventory must invalidate this tab's HUD
// balance. Registered once; the listener no-ops where unsupported.
onInventoryChanged(refreshBalance);

/**
 * Import a pasted cashuB (F4): dedup against held proofs + NUT-07 state-check
 * against the mint so a double-paste or an already-spent token is rejected with
 * a clear message rather than inflating the balance. Network-checked in live
 * mode; falls back to the offline dedup path if the mint is unreachable.
 */
async function doImport(token: string): Promise<void> {
  if (!config) return;
  try {
    const check = buildProofStateChecker(config.mintUrl, config.unit);
    const { added, rejected, checked } = await importTokenChecked(
      token,
      config.mintUrl,
      config.unit,
      check,
    );
    const note = rejected > 0 ? ` (${rejected} already-spent rejected)` : "";
    const verified = checked ? "" : " (mint unreachable — not state-checked)";
    hud.status(`imported ${added} ${config.unit}${note}${verified}`);
  } catch (e) {
    hud.status(`import failed: ${e instanceof Error ? e.message : e}`);
  }
  refreshBalance();
}

/* ------------------------------- input ------------------------------------ */

const keys = new Set<string>();
let lastIntent = "0,0";

function intentFromKeys(): { x: number; z: number } {
  let x = 0;
  let z = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) z += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) z -= 1;
  // Camera chases from -Z looking toward +Z, so world +X reads as screen-LEFT:
  // A (screen-left) must be +X, D (screen-right) -X. Flip these if the camera flips.
  if (keys.has("KeyA") || keys.has("ArrowLeft")) x += 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) x -= 1;
  return { x, z };
}

function pushIntent(): void {
  const intent = intentFromKeys();
  const key = `${intent.x},${intent.z}`;
  if (key !== lastIntent) {
    lastIntent = key;
    net.move(intent.x, intent.z);
  }
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  audio.start(); // first gesture unlocks the ambience
  if (isTyping(e)) return;
  if (e.code === "KeyB") void actSpawn();
  if (e.code === "KeyE") {
    // While a bell play is live, [E] RINGS it; otherwise it interacts.
    if (booths.bellActive) {
      void pressBell();
    } else {
      void actInteract();
    }
  }
  if (e.code === "Space") net.jump();
  if (e.code === "KeyM") hud.status(audio.toggleMute() ? "muted" : "sound on");
  if (e.code === "Enter" || e.code === "KeyT") {
    if (kind === "body") {
      hud.focusChat();
      e.preventDefault();
      return;
    }
  }
  keys.add(e.code);
  pushIntent();
});
window.addEventListener("keyup", (e: KeyboardEvent) => {
  keys.delete(e.code);
  pushIntent();
});
window.addEventListener("pointerdown", () => audio.start(), { once: true });

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
}

/* ------------------------------ actions ----------------------------------- */

async function actSpawn(): Promise<void> {
  if (kind === "body" || paying) return;
  await payAndReport("/spawn", "spawn");
}

async function actInteract(): Promise<void> {
  if (paying || !world || !scene) return;
  const pos = scene.selfPosition();
  if (!pos) return;

  // Nearest interactable: booths + chests first (3.0 reach), then court doors.
  const booth = nearestBooth(pos);
  if (booth && kind === "body") {
    await engageBooth(booth);
    return;
  }
  for (const chest of world.chests) {
    if (dist(pos, chest) < 3.0 && kind === "body") {
      net.interact(chest.id);
      return;
    }
  }
  for (const court of world.courts) {
    const door = {
      x: (court.door.x1 + court.door.x2) / 2,
      z: court.bounds.minZ,
    };
    if (dist(pos, door) < 4.0) {
      if (entitlements.has(court.gate)) {
        hud.status(`${court.id} is already open for this session — walk in.`);
        return;
      }
      if (kind !== "body") {
        hud.status("ghosts cannot enter courts — buy a body first ([B]).");
        return;
      }
      await payAndReport(`/enter/${court.id}`, court.gate);
      return;
    }
  }
  hud.status("nothing in reach.");
}

async function payAndReport(path: string, gate: string): Promise<void> {
  if (!session || !wallet || !config) return;
  const price = config.prices[gate] ?? 0;
  paying = true;
  hud.status(
    config.mode === "mock"
      ? `requesting ${gate} (mock mode, free)…`
      : `paying ${price} ${config.unit} for ${gate}…`,
  );
  try {
    const result = await payGate(path, session, wallet, {
      maxAmount: price,
      mintUrl: config.mintUrl,
      unit: config.unit,
    });
    if (result.ok) {
      hud.status(
        result.spent > 0
          ? `paid ${result.spent} — ${gate} granted.`
          : `${gate} granted.`,
      );
    } else {
      hud.status(`payment failed (${result.reason ?? result.status})`);
    }
  } catch (e) {
    surfacePayError(e);
  } finally {
    paying = false;
    refreshBalance();
  }
}

/**
 * Surface a pay-path error. An {@link InventoryWriteError} (F2) is value-at-risk:
 * the swap succeeded at the mint but the change/token could not be persisted, so
 * we show a LOUD message and hand the user the recovery token to copy off-device
 * NOW rather than letting the value silently burn.
 */
function surfacePayError(e: unknown): void {
  if (e instanceof InventoryWriteError) {
    hud.status(
      "⚠ STORAGE FULL — your ecash could not be saved. Copy the recovery token now and import it into another wallet.",
    );
    if (e.recoveryToken) hud.showPrize(e.recoveryToken);
    return;
  }
  hud.status(`payment error: ${e instanceof Error ? e.message : e}`);
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/* -------------------------------- booths ---------------------------------- */

function nearestBooth(pos: { x: number; z: number }): BoothSpec | null {
  if (!world) return null;
  for (const b of world.booths) {
    if (dist(pos, b) < 3.0) return b;
  }
  return null;
}

/** Engage a booth: the riddle opens its modal (free, ws); paid booths run a
 * play through the existing payGate against /play/:kind. */
async function engageBooth(booth: BoothSpec): Promise<void> {
  if (booth.kind === "riddle") {
    net.interact(booth.id); // server replies with `riddle` -> modal opens
    return;
  }
  if (booth.kind === "gacha") {
    await playGacha(booth);
  } else if (booth.kind === "bell") {
    await playBell(booth);
  }
}

/** Pay for one play and return the parsed result body (or null on failure). */
async function payAndPlay(path: string, price: number, label: string): Promise<unknown | null> {
  if (!session || !wallet || !config) return null;
  paying = true;
  hud.status(
    config.mode === "mock"
      ? `playing ${label} (mock mode, free)…`
      : `paying ${price} ${config.unit} to play ${label}…`,
  );
  try {
    const result = await payGate(path, session, wallet, {
      maxAmount: price,
      mintUrl: config.mintUrl,
      unit: config.unit,
    });
    if (!result.ok) {
      hud.status(`play failed (${result.reason ?? result.status})`);
      return null;
    }
    return result.body ?? null;
  } catch (e) {
    surfacePayError(e);
    return null;
  } finally {
    paying = false;
    refreshBalance();
  }
}

async function playGacha(booth: BoothSpec): Promise<void> {
  const body = (await payAndPlay("/play/gacha", booth.price, "the gacha shrine")) as
    | GachaResult
    | null;
  if (!body) return;
  audio.blip();
  booths.showGacha(body);
  hud.status(body.win ? "the shrine answers — a charm!" : "the shrine is quiet. Try again.");
}

async function playBell(booth: BoothSpec): Promise<void> {
  const body = (await payAndPlay("/play/bell", booth.price, "the timing bell")) as BellPlay | null;
  if (!body) return;
  booths.startBell(body);
  hud.status("watch the bob — press [E] as it crosses the center.");
}

/** Ring the live bell: POST the press (free, session-checked) and resolve. */
async function pressBell(): Promise<void> {
  if (!session || !config || !booths.bellActive) return;
  booths.bellPressed();
  try {
    const resp = await fetch("/play/bell/press", {
      method: "POST",
      headers: { "x-bazaar-session": session },
    });
    if (!resp.ok) {
      booths.bellResult(false, 0, false);
      hud.status("the bell would not ring (the moment may have passed).");
      return;
    }
    const r = (await resp.json()) as BellPressResult;
    audio.chime();
    booths.bellResult(r.hit, r.offsetMs, r.soldOut ?? false);
    hud.status(r.hit ? "RING — you timed it!" : "clang… off the beat.");
  } catch (e) {
    booths.bellResult(false, 0, false);
    hud.status(`bell error: ${e instanceof Error ? e.message : e}`);
  }
}

/* ------------------------------ prompt loop -------------------------------- */

function updatePrompt(): void {
  if (!world || !scene) return;
  const pos = scene.selfPosition();
  if (!pos) return;
  // Bell mid-play: the prompt is the ring cue (handled by the bell overlay).
  if (booths.bellActive) {
    hud.prompt("[E] RING the bell — time the center crossing");
    return;
  }
  const booth = nearestBooth(pos);
  if (booth) {
    if (kind !== "body") {
      hud.prompt("a booth… buy a body to play ([B])");
    } else if (booth.kind === "riddle") {
      hud.prompt("[E] read the riddle (free)");
    } else if (booth.kind === "gacha") {
      hud.prompt(`[E] pull the gacha — ${booth.price} pops`);
    } else if (booth.kind === "bell") {
      hud.prompt(`[E] play the timing bell — ${booth.price} pops`);
    }
    return;
  }
  for (const chest of world.chests) {
    if (dist(pos, chest) < 3.0) {
      const aloft = chest.y > 1.5;
      hud.prompt(
        chestsClaimed.get(chest.id)
          ? "this chest has already been looted"
          : kind === "body"
            ? aloft
              ? "it's up on the roof — [Space] jump, [E] mid-air"
              : "[E] open the chest"
            : "a chest… ghosts cannot touch it",
      );
      return;
    }
  }
  for (const court of world.courts) {
    const door = { x: (court.door.x1 + court.door.x2) / 2, z: court.bounds.minZ };
    if (dist(pos, door) < 4.0) {
      hud.prompt(
        entitlements.has(court.gate)
          ? `${court.id} court — open for you`
          : `[E] pay ${court.price} — ${court.id} court`,
      );
      return;
    }
  }
  hud.prompt(kind === "ghost" ? "[B] buy a body to touch the world" : null);
}

/* -------------------------------- frame loop ------------------------------ */

let last = performance.now();
let tAccum = 0;
function frame(now: number): void {
  const dt = now - last;
  last = now;
  tAccum += dt;
  if (scene) {
    crowd?.update(tAccum, dt);
    scene.tick(dt);
    audio.update(scene.selfPosition(), scene.noodlePos);
  }
  booths.tick();
  updatePrompt();
  if (scene && tAccum % 1000 < 20) {
    hud.fps(`${scene.fps} fps · ${scene.backendName}`);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

net.connect();
