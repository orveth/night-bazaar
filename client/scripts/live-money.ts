// INTERNAL DEV SCRIPT: not part of the game; the full live-money end-to-end verification suite.
/**
 * LIVE MONEY E2E against the shared Mutinynet rig.
 *
 *   bun scripts/live-money.ts <serverBase> <bankrollTokenFile> <outDir> <vaultFile>
 *
 * Spends REAL (test-sat) pops from the FOR-MPP-JAMS bankroll. Steps:
 *   1. /api/config sanity (mode=live, unit from the mint).
 *   2. Import the bankroll into an in-memory inventory.
 *   3. ws session -> pay /spawn with THIS codec (challenge held manually).
 *   4. REPLAY the exact spent spawn credential -> expect 402 verification-failed.
 *   5. payGate(/enter/jade) through payer.ts (the production path).
 *   6. WRONG AMOUNT: 10-pop token vs the 50-pop jade challenge -> expect
 *      402 payment-insufficient; re-import the untouched token.
 *   7. Carve a 21-pop prize -> write the vault -> walk to the chest -> claim
 *      -> assert the prize IS that exact token; double-claim rejected.
 *   8. Carve a browser bankroll (for the in-browser payer pass), save all
 *      change as the next bankroll file. Nothing outside the bankroll is
 *      touched.
 */

/* eslint-disable no-console */

export {}; // top-level await needs module-ness under tsc

// In-memory localStorage BEFORE the wallet module loads.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as Storage;

const [serverBase, bankrollFile, outDir, vaultFile] = process.argv.slice(2);
if (!serverBase || !bankrollFile || !outDir || !vaultFile) {
  console.error(
    "usage: bun scripts/live-money.ts <serverBase> <bankrollTokenFile> <outDir> <vaultFile>",
  );
  process.exit(2);
}

const { importToken, getBalance, buildPopWallet, localInventory } = await import(
  "../src/wallet.ts"
);
const { payGate } = await import("../src/payer.ts");
const {
  parsePaymentChallenge,
  decodeRequestObject,
  assertPayable,
  buildCredential,
  problemSlug,
} = await import("../src/charge01.ts");
const { getEncodedToken } = await import("@cashu/cashu-ts");
const { SESSION_HEADER } = await import("../../protocol/protocol.ts");

const results: Record<string, unknown>[] = [];
const step = (name: string, detail: Record<string, unknown>) => {
  console.log(`✔ ${name}`, JSON.stringify(detail));
  results.push({ step: name, ...detail });
};
const fail = (name: string, detail: unknown): never => {
  console.error(`✗ ${name}`, detail);
  console.error(JSON.stringify({ results, failed: name }, null, 2));
  process.exit(1);
};

/* 1: config */
const config = (await (await fetch(`${serverBase}/api/config`)).json()) as {
  mintUrl: string;
  unit: string;
  prices: Record<string, number>;
  mode: string;
};
if (config.mode !== "live") fail("config", `server mode is ${config.mode}, want live`);
if (!config.unit.startsWith("pop_")) fail("config", `unit ${config.unit}`);
step("config", config);

/* 2: bankroll in */
const bankroll = (await Bun.file(bankrollFile).text()).trim();
importToken(bankroll, config.mintUrl, config.unit);
const opening = getBalance(config.mintUrl, config.unit);
step("bankroll-imported", opening);
const wallet = buildPopWallet(config.mintUrl, config.unit);

/* 3: ws session */
type Msg = Record<string, unknown>;
const inbox: Msg[] = [];
const ws = new WebSocket(`${serverBase.replace(/^http/, "ws")}/ws`);
ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)) as Msg);
const waitFor = async <T>(pred: (m: Msg) => T | undefined, what: string, ms = 8000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    for (const m of inbox) {
      const hit = pred(m);
      if (hit !== undefined) return hit;
    }
    if (Date.now() - t0 > ms) return fail(what, `timeout; inbox tail: ${JSON.stringify(inbox.slice(-3))}`);
    await new Promise((r) => setTimeout(r, 60));
  }
};
const session = await waitFor(
  (m) => (m.type === "hello" ? (m.session as string) : undefined),
  "hello",
);
step("session", { session });
const send = (m: unknown) => ws.send(JSON.stringify(m));

/* 4: spawn paid with this codec, challenge held manually (for the replay) */
const spawnUrl = `${serverBase}/spawn`;
const bare = await fetch(spawnUrl, { method: "POST", headers: { [SESSION_HEADER]: session } });
if (bare.status !== 402) fail("spawn-bare", `status ${bare.status}`);
const challenge = parsePaymentChallenge(bare.headers.get("www-authenticate")!);
const reqObj = decodeRequestObject(challenge.request);
const creqa = await wallet.decodeRequest(reqObj.methodDetails.paymentRequest);
assertPayable(challenge, reqObj, creqa);
if (creqa.amount !== config.prices["spawn"]) fail("spawn-price", creqa);
const spawnToken = await wallet.payPopRequest(creqa);
const spawnAuth = buildCredential(challenge, spawnToken);
const paid = await fetch(spawnUrl, {
  method: "POST",
  headers: { [SESSION_HEADER]: session, authorization: spawnAuth },
});
if (paid.status !== 200) fail("spawn-paid", `status ${paid.status}: ${await paid.text()}`);
const receipt = paid.headers.get("payment-receipt");
await waitFor((m) => (m.type === "entitlement" && m.gate === "spawn" ? true : undefined), "spawn-entitlement");
step("spawn-paid", { amount: creqa.amount, receipt: receipt?.slice(0, 24) + "…" });

/* 5: replay the EXACT spent credential -> 402 verification-failed */
const replay = await fetch(spawnUrl, {
  method: "POST",
  headers: { [SESSION_HEADER]: session, authorization: spawnAuth },
});
const replayBody = (await replay.json().catch(() => ({}))) as Msg;
if (replay.status !== 402) fail("replay", `status ${replay.status}, want 402`);
const replaySlug = problemSlug(replayBody);
if (replaySlug !== "verification-failed") fail("replay", `slug ${replaySlug}`);
step("replay-rejected", { status: replay.status, slug: replaySlug });

/* 6: jade through the production payer */
const jade = await payGate(`${serverBase}/enter/jade`, session, wallet, {
  maxAmount: config.prices["court.jade"]!,
  mintUrl: config.mintUrl,
});
if (!jade.ok) fail("jade-paid", jade);
await waitFor((m) => (m.type === "entitlement" && m.gate === "court.jade" ? true : undefined), "jade-entitlement");
step("jade-paid", { spent: jade.spent, receipt: jade.receipt ? "yes" : "no" });

/* 7: wrong amount: a 10-pop token against the 50-pop jade challenge */
const bareJade = await fetch(`${serverBase}/enter/jade`, {
  method: "POST",
  headers: { [SESSION_HEADER]: session },
});
const jadeChallenge = parsePaymentChallenge(bareJade.headers.get("www-authenticate")!);
const tenToken = await wallet.payPopRequest({ amount: 10, unit: config.unit, mints: [config.mintUrl] });
const wrong = await fetch(`${serverBase}/enter/jade`, {
  method: "POST",
  headers: { [SESSION_HEADER]: session, authorization: buildCredential(jadeChallenge, tenToken) },
});
const wrongBody = (await wrong.json().catch(() => ({}))) as Msg;
const wrongSlug = problemSlug(wrongBody);
if (wrong.status !== 402 || wrongSlug !== "payment-insufficient") {
  fail("wrong-amount", { status: wrong.status, slug: wrongSlug });
}
// The under-amount token was rejected BEFORE the swap; still ours: reclaim it.
importToken(tenToken, config.mintUrl, config.unit);
step("wrong-amount-rejected", { status: wrong.status, slug: wrongSlug, reclaimed: 10 });

/* 8: stock the vault with a real 21-pop prize, walk to the chest, claim */
const prizeToken = await wallet.payPopRequest({ amount: 21, unit: config.unit, mints: [config.mintUrl] });
await Bun.write(vaultFile, JSON.stringify([prizeToken]));
step("vault-stocked", { amount: 21, file: vaultFile });

const selfPos = (m: Msg): { x: number; z: number } | undefined => {
  if (m.type !== "state") return undefined;
  const players = m.players as { id: string; x: number; z: number }[];
  const me = players.find((p) => p.id === session);
  return me ? { x: me.x, z: me.z } : undefined;
};
const walkTo = async (tx: number, tz: number, what: string, ms = 25000) => {
  const t0 = Date.now();
  for (;;) {
    inbox.length = 0;
    const pos = await waitFor(selfPos, `walk:${what}`);
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    if (Math.hypot(dx, dz) < 0.7) {
      send({ type: "move", x: 0, z: 0 });
      return;
    }
    if (Date.now() - t0 > ms) return fail(`walk:${what}`, `stuck at ${JSON.stringify(pos)}`);
    const n = Math.hypot(dx, dz);
    send({ type: "move", x: dx / n, z: dz / n });
    await new Promise((r) => setTimeout(r, 100));
  }
};
await walkTo(-14, 6, "door-lane");
await walkTo(-14, 13, "through-door");
await walkTo(-14, 19.5, "chest");
step("walked-into-jade", {});

inbox.length = 0;
send({ type: "interact", target: "chest.jade" });
const prize = await waitFor(
  (m) => (m.type === "prize" ? (m.token as string) : undefined),
  "prize",
);
if (prize !== prizeToken) fail("prize", "prize token != the vault token we staged");
step("chest-claimed", { tokenMatchesVault: true, amount: 21 });

inbox.length = 0;
send({ type: "interact", target: "chest.jade" });
const dbl = await waitFor(
  (m) => (m.type === "error" ? (m.code as string) : undefined),
  "double-claim",
);
if (dbl !== "chest-claimed") fail("double-claim", `code ${dbl}`);
step("double-claim-rejected", { code: dbl });

// The prize is REAL ecash: bring it back into the bankroll so nothing leaks.
importToken(prize, config.mintUrl, config.unit);

/* 9: carve the browser bankroll + persist the change */
const browserToken = await wallet.payPopRequest({ amount: 250, unit: config.unit, mints: [config.mintUrl] });
await Bun.write(`${outDir}/browser-bankroll.txt`, browserToken);

const remaining = await localInventory.load(config.mintUrl, config.unit);
const changeToken = getEncodedToken({
  mint: config.mintUrl,
  proofs: remaining,
  unit: config.unit,
});
await Bun.write(`${outDir}/bankroll-next.txt`, changeToken);
const closing = getBalance(config.mintUrl, config.unit);
step("settled", {
  openingBalance: opening.balance,
  closingBalance: closing.balance,
  spentOnGates: 10 + 50,
  carvedForBrowser: 250,
  prizeRecycled: 21,
  changeFile: `${outDir}/bankroll-next.txt`,
});

ws.close();
console.log(JSON.stringify({ ok: true, results }, null, 2));
process.exit(0);
