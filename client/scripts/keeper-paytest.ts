// INTERNAL DEV SCRIPT: not part of the game; used to smoke-test the full live spawn-gate payment path.
/**
 * Keeper smoke: pay JUST the spawn gate (10) through the full live path
 * (swap at the mint, present, middleware verify, entitlement push), then bank
 * the change. Banks on EVERY exit path.
 * usage: bun scripts/keeper-paytest.ts <serverBase> <bankrollTokenFile>
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
  console.error("usage: bun scripts/keeper-paytest.ts <serverBase> <bankrollTokenFile>");
  process.exit(2);
}

const { importToken, getBalance, buildPopWallet, localInventory } = await import("../src/wallet.ts");
const { payGate } = await import("../src/payer.ts");
const { getEncodedToken } = await import("@cashu/cashu-ts");

const config = (await (await fetch(`${serverBase}/api/config`)).json()) as {
  mintUrl: string;
  unit: string;
  acceptedUnits?: string[];
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
    console.log(`[bank:${label}] inventory empty, nothing to write`);
    return;
  }
  const changeToken = getEncodedToken({ mint: config.mintUrl, proofs: remaining, unit: config.unit });
  await Bun.write(bankrollFile, changeToken);
  const total = remaining.reduce((s: number, p) => s + Number(p.amount as unknown as number), 0);
  console.log(`[bank:${label}] ${total} → ${bankrollFile}`);
};

let ok = false;
try {
  const bankroll = (await Bun.file(bankrollFile).text()).trim();
  importToken(bankroll, config.mintUrl, config.unit);
  console.log("opening balance:", getBalance(config.mintUrl, config.unit).balance);

  const wallet = buildPopWallet(config.mintUrl, config.unit);

  const inbox: Record<string, unknown>[] = [];
  const ws = new WebSocket(`${serverBase.replace(/^http/, "ws")}/ws`);
  ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
  const waitFor = async <T>(pred: (m: Record<string, unknown>) => T | undefined, what: string): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      for (const m of inbox) {
        const hit = pred(m);
        if (hit !== undefined) return hit;
      }
      if (Date.now() - t0 > 10000) {
        throw new Error(`timeout waiting for ${what}; inbox tail: ${JSON.stringify(inbox.slice(-2))}`);
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  };

  const session = await waitFor((m) => (m.type === "hello" ? (m.session as string) : undefined), "hello");
  console.log("session:", session);

  // Declare the held unit (multi-unit accept): the server issues the challenge
  // in config.unit even if it is not the newest, proving the dispatch path.
  const res = await payGate(`${serverBase}/spawn`, session, wallet, {
    maxAmount: 50,
    mintUrl: config.mintUrl,
    unit: config.unit,
    fetchImpl: fetch,
  });
  console.log("payGate result:", JSON.stringify(res).slice(0, 200));
  if (!res.ok) throw new Error(`payGate failed: ${JSON.stringify(res).slice(0, 160)}`);

  await waitFor((m) => (m.type === "entitlement" && m.gate === "spawn" ? true : undefined), "spawn entitlement");
  console.log("✔ entitlement received; full live path OK");
  ws.close();
  ok = true;
} catch (e) {
  console.error("FAILED:", e instanceof Error ? e.message : e);
} finally {
  await bankAll(ok ? "success" : "failure-path");
  process.exit(ok ? 0 : 1);
}
