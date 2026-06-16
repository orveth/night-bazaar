/**
 * Instrumented one-off: replicate payGate's steps manually against /spawn,
 * print the FULL problem body on failure, and bank ALL remnants to a file on
 * every path (the 19:16 paytest burned the bankroll by exiting pre-bank).
 * usage: bun scripts/keeper-debug-pay.ts <serverBase> <tokenFile> <bankOutFile>
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
const { parsePaymentChallenge, decodeRequestObject, buildCredential } = await import("../src/charge01.ts");
const { getEncodedToken } = await import("@cashu/cashu-ts");

const config = (await (await fetch(`${serverBase}/api/config`)).json()) as {
  mintUrl: string;
  unit: string;
  mode: string;
};
console.log("config:", JSON.stringify(config));

const bankAll = async (label: string) => {
  const remaining = await localInventory.load(config.mintUrl, config.unit);
  if (remaining.length === 0) {
    console.log(`[bank:${label}] inventory empty`);
    return;
  }
  const tok = getEncodedToken({ mint: config.mintUrl, proofs: remaining, unit: config.unit });
  await Bun.write(bankOut, tok);
  const total = remaining.reduce((s: number, p: { amount: number }) => s + Number(p.amount), 0);
  console.log(`[bank:${label}] ${total} → ${bankOut}`);
};

try {
  const raw = (await Bun.file(tokenFile).text()).trim();
  importToken(raw, config.mintUrl, config.unit);
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

  const r1 = await fetch(`${serverBase}/spawn?session=${session}`, { method: "POST" });
  const h = r1.headers.get("www-authenticate") || "";
  const challenge = parsePaymentChallenge(h);
  const creqa = decodeRequestObject(challenge.request);
  console.log("challenge:", challenge.id.slice(0, 12), "amount:", creqa.amount, "mints:", JSON.stringify(creqa.mints));

  const token = await wallet.payPopRequest(creqa);
  console.log("token built: len", token.length, "prefix", token.slice(0, 24), "suffix", token.slice(-12));

  const auth = buildCredential(challenge, token);
  const r2 = await fetch(`${serverBase}/spawn?session=${session}`, {
    method: "POST",
    headers: { authorization: auth },
  });
  console.log("present status:", r2.status);
  console.log("present body:", (await r2.text()).slice(0, 600));

  if (r2.status !== 200) {
    // un-redeemed credential token is still money — reclaim it to inventory
    importToken(token, config.mintUrl, config.unit);
    console.log("reclaimed un-redeemed credential token to inventory");
  }
  ws.close();
} catch (e) {
  console.error("ERROR:", e instanceof Error ? e.message : e);
} finally {
  await bankAll("final");
  process.exit(0);
}
