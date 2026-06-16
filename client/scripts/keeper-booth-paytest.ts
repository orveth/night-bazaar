/**
 * Keeper LIVE-MONEY booth smoke against the shared Mutinynet rig. Proves the
 * two PAID booth flows end to end through the production payer:
 *   - gacha shrine: spawn -> enter crimson -> walk to the shrine -> ONE paid
 *     pull -> assert a result body came back.
 *   - timing bell: walk to the street bell -> ONE paid play -> press -> assert
 *     a judged result.
 * The riddle is FREE (and ships with empty stock live) so it is exercised in
 * the unit tests, not here.
 *
 * SAFETY: spends REAL (test-sat) pops from the FOR-MPP-JAMS bankroll, and banks
 * ALL remaining change to the bankroll file on EVERY exit path (a prior script
 * burned the bankroll by exiting before banking — never again).
 *
 * usage: bun scripts/keeper-booth-paytest.ts <serverBase> <bankrollTokenFile>
 */

export {};

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as Storage;

const [serverBase, bankrollFile] = process.argv.slice(2);
if (!serverBase || !bankrollFile) {
  console.error("usage: bun scripts/keeper-booth-paytest.ts <serverBase> <bankrollTokenFile>");
  process.exit(2);
}
const base = serverBase;

const { importToken, getBalance, buildPopWallet, localInventory } = await import("../src/wallet.ts");
const { payGate } = await import("../src/payer.ts");
const { getEncodedToken } = await import("@cashu/cashu-ts");

type Msg = Record<string, unknown>;
const config = (await (await fetch(`${base}/api/config`)).json()) as {
  mintUrl: string;
  unit: string;
  prices: Record<string, number>;
  mode: string;
};
if (config.mode !== "live") {
  console.error(`mode=${config.mode}, want live`);
  process.exit(1);
}
console.log("config:", JSON.stringify(config));

const bankAll = async (label: string): Promise<void> => {
  const remaining = await localInventory.load(config.mintUrl, config.unit);
  if (remaining.length === 0) {
    console.log(`[bank:${label}] inventory empty — nothing to write`);
    return;
  }
  const changeToken = getEncodedToken({ mint: config.mintUrl, proofs: remaining, unit: config.unit });
  await Bun.write(bankrollFile, changeToken);
  const total = remaining.reduce((s: number, p) => s + Number(p.amount as unknown as number), 0);
  console.log(`[bank:${label}] ${total} → ${bankrollFile}`);
};

let ok = false;
let ws: WebSocket | null = null;
try {
  const bankroll = (await Bun.file(bankrollFile).text()).trim();
  importToken(bankroll, config.mintUrl, config.unit);
  console.log("opening balance:", getBalance(config.mintUrl, config.unit).balance);
  const wallet = buildPopWallet(config.mintUrl, config.unit);

  const inbox: Msg[] = [];
  ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
  ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)) as Msg);
  const waitFor = async <T>(pred: (m: Msg) => T | undefined, what: string, ms = 12000): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      for (const m of inbox) {
        const hit = pred(m);
        if (hit !== undefined) return hit;
      }
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; tail ${JSON.stringify(inbox.slice(-2))}`);
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const send = (m: unknown) => ws!.send(JSON.stringify(m));

  const session = await waitFor((m) => (m.type === "hello" ? (m.session as string) : undefined), "hello");
  const world = await waitFor((m) => (m.type === "hello" ? (m.world as Msg) : undefined), "world");
  console.log("session:", session);
  const booths = world.booths as { id: string; kind: string; x: number; z: number }[];
  const gacha = booths.find((b) => b.kind === "gacha")!;
  const bell = booths.find((b) => b.kind === "bell")!;

  const selfPos = (m: Msg): { x: number; z: number } | undefined => {
    if (m.type !== "state") return undefined;
    const players = m.players as { id: string; x: number; z: number }[];
    const me = players.find((p) => p.id === session);
    return me ? { x: me.x, z: me.z } : undefined;
  };
  const walkTo = async (tx: number, tz: number, what: string, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      inbox.length = 0;
      const pos = await waitFor(selfPos, `walk:${what}`);
      const dx = tx - pos.x;
      const dz = tz - pos.z;
      if (Math.hypot(dx, dz) < 0.6) {
        send({ type: "move", x: 0, z: 0 });
        return;
      }
      if (Date.now() - t0 > ms) throw new Error(`walk:${what} stuck at ${JSON.stringify(pos)}`);
      const n = Math.hypot(dx, dz);
      send({ type: "move", x: dx / n, z: dz / n });
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // 1. spawn (body).
  const spawn = await payGate(`${base}/spawn`, session, wallet, { maxAmount: config.prices["spawn"]!, mintUrl: config.mintUrl });
  if (!spawn.ok) throw new Error(`spawn failed: ${JSON.stringify(spawn).slice(0, 160)}`);
  await waitFor((m) => (m.type === "entitlement" && m.gate === "spawn" ? true : undefined), "spawn-entitlement");
  console.log("✔ spawned (paid", spawn.spent, ")");

  // 2. enter crimson, walk to the gacha shrine.
  const crimson = await payGate(`${base}/enter/crimson`, session, wallet, { maxAmount: config.prices["court.crimson"]!, mintUrl: config.mintUrl });
  if (!crimson.ok) throw new Error(`crimson failed: ${JSON.stringify(crimson).slice(0, 160)}`);
  await waitFor((m) => (m.type === "entitlement" && m.gate === "court.crimson" ? true : undefined), "crimson-entitlement");
  console.log("✔ entered crimson (paid", crimson.spent, ")");
  // Through the crimson door (x in [12,16]) then to the shrine.
  await walkTo(14, 8.5, "crimson-door-lane");
  await walkTo(14, 12.5, "through-crimson-door");
  await walkTo(gacha.x, gacha.z, "gacha-shrine");
  console.log("✔ at the gacha shrine", JSON.stringify({ x: gacha.x, z: gacha.z }));

  // 3. ONE paid gacha pull -> result body.
  const pull = await payGate(`${base}/play/gacha`, session, wallet, { maxAmount: config.prices["play.gacha"] ?? 5, mintUrl: config.mintUrl });
  if (!pull.ok) throw new Error(`gacha pull failed: ${JSON.stringify(pull).slice(0, 200)}`);
  const gachaBody = pull.body as { play: string; win: boolean; fortune: string; pity: number } | undefined;
  if (!gachaBody || gachaBody.play !== "gacha") throw new Error(`no gacha result body: ${JSON.stringify(pull.body)}`);
  console.log("✔ GACHA PULL paid", pull.spent, "→", JSON.stringify(gachaBody));

  // 4. back to the street, to the bell.
  await walkTo(14, 12.5, "back-to-crimson-door");
  await walkTo(14, 8.0, "out-of-crimson");
  await walkTo(bell.x, bell.z, "street-bell");
  console.log("✔ at the timing bell", JSON.stringify({ x: bell.x, z: bell.z }));

  // 5. ONE paid bell play -> press -> judged result.
  const play = await payGate(`${base}/play/bell`, session, wallet, { maxAmount: config.prices["play.bell"] ?? 3, mintUrl: config.mintUrl });
  if (!play.ok) throw new Error(`bell play failed: ${JSON.stringify(play).slice(0, 200)}`);
  const bellBody = play.body as { play: string; playId: string; periodMs: number } | undefined;
  if (!bellBody || bellBody.play !== "bell") throw new Error(`no bell play body: ${JSON.stringify(play.body)}`);
  console.log("✔ BELL PLAY paid", play.spent, "→", JSON.stringify(bellBody));

  // Press it (free, session-checked). Timing is whatever the server clock says.
  const pressResp = await fetch(`${base}/play/bell/press`, { method: "POST", headers: { "x-bazaar-session": session } });
  const pressBody = (await pressResp.json()) as { hit: boolean; offsetMs: number };
  if (pressResp.status !== 200) throw new Error(`bell press status ${pressResp.status}: ${JSON.stringify(pressBody)}`);
  console.log("✔ BELL PRESS judged →", JSON.stringify(pressBody));

  ws.close();
  ok = true;
  console.log("ALL PAID BOOTH FLOWS OK (gacha pull + bell play+press, real mint)");
} catch (e) {
  console.error("FAILED:", e instanceof Error ? e.message : e);
} finally {
  try {
    ws?.close();
  } catch {}
  await bankAll(ok ? "success" : "failure-path");
  process.exit(ok ? 0 : 1);
}
