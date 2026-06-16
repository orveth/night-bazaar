// INTERNAL DEV SCRIPT: not part of the game; used to debug the full payGate path with request/response logging.
/**
 * One-off: the REAL payGate composition, with fetchImpl wrapped to log every
 * request/response body (clone), and bank-all-on-exit. No reimplementation.
 * usage: bun scripts/keeper-debug-pay2.ts <serverBase> <tokenFile> <bankOutFile>
 */

export {};

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as Storage;

const [serverBase, tokenFile, bankOut] = process.argv.slice(2);
const { importToken, getBalance, buildPopWallet, localInventory } = await import("../src/wallet.ts");
const { payGate } = await import("../src/payer.ts");
const { getEncodedToken } = await import("@cashu/cashu-ts");

const config = (await (await fetch(`${serverBase}/api/config`)).json()) as {
  mintUrl: string;
  unit: string;
  mode: string;
};

const loggingFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
  if (auth) {
    console.log(`>> ${method} ${url} AUTH len=${auth.length} head=${auth.slice(0, 40)}…`);
    await Bun.write("/tmp/bazaar-failing-credential.txt", auth);
    console.log("   (full Authorization header dumped to /tmp/bazaar-failing-credential.txt)");
  } else console.log(`>> ${method} ${url}`);
  const res = await fetch(input, init);
  const clone = res.clone();
  let body = "";
  try {
    body = await clone.text();
  } catch {
    body = "(unreadable)";
  }
  console.log(`<< ${res.status} ${url}\n   ${body || "(empty body)"}`);
  if (body) await Bun.write(`/tmp/bazaar-402-body-${res.status}.json`, body);
  return res;
};

const bankAll = async (label: string) => {
  const remaining = await localInventory.load(config.mintUrl, config.unit);
  if (remaining.length === 0) return console.log(`[bank:${label}] inventory empty`);
  await Bun.write(bankOut, getEncodedToken({ mint: config.mintUrl, proofs: remaining, unit: config.unit }));
  const total = remaining.reduce((s: number, p: { amount: number }) => s + Number(p.amount), 0);
  console.log(`[bank:${label}] ${total} → ${bankOut}`);
};

try {
  importToken((await Bun.file(tokenFile).text()).trim(), config.mintUrl, config.unit);
  console.log("imported, balance:", getBalance(config.mintUrl, config.unit).balance);
  const wallet = buildPopWallet(config.mintUrl, config.unit);

  const ws = new WebSocket(`${serverBase.replace(/^http/, "ws")}/ws`);
  const session = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hello timeout")), 8000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string; session?: string };
      if (m.type === "hello") {
        clearTimeout(t);
        resolve(m.session as string);
      }
    };
  });
  console.log("session:", session);

  const res = await payGate(`${serverBase}/spawn`, session, wallet, {
    maxAmount: 50,
    mintUrl: config.mintUrl,
    fetchImpl: loggingFetch,
  });
  console.log("payGate:", JSON.stringify(res).slice(0, 300));
  ws.close();
} catch (e) {
  console.error("ERROR:", e instanceof Error ? e.message : e);
} finally {
  await bankAll("final");
  process.exit(0);
}
