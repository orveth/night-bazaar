/**
 * One-off keeper carve (6/10): from the live bankroll, carve
 *   - a 500-pop player token for gudnuf
 *   - a 42-pop chest prize for the vault
 * then persist ALL change as the next bankroll. Mirrors live-money.ts rails.
 * usage: bun scripts/keeper-carve.ts <serverBase> <bankrollTokenFile> <outDir>
 */

export {};

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as Storage;

const [serverBase, bankrollFile, outDir] = process.argv.slice(2);
if (!serverBase || !bankrollFile || !outDir) {
  console.error("usage: bun scripts/keeper-carve.ts <serverBase> <bankrollTokenFile> <outDir>");
  process.exit(2);
}

const { importToken, getBalance, buildPopWallet, localInventory } = await import(
  "../src/wallet.ts"
);
const { getEncodedToken } = await import("@cashu/cashu-ts");

const config = (await (await fetch(`${serverBase}/api/config`)).json()) as {
  mintUrl: string;
  unit: string;
  mode: string;
};
if (config.mode !== "live" || !config.unit.startsWith("pop_")) {
  console.error(`bad config: ${JSON.stringify(config)}`);
  process.exit(1);
}

const bankroll = (await Bun.file(bankrollFile).text()).trim();
importToken(bankroll, config.mintUrl, config.unit);
const opening = getBalance(config.mintUrl, config.unit);

const PLAYER = Number(process.env.CARVE_PLAYER ?? 500);
const PRIZE = Number(process.env.CARVE_PRIZE ?? 42);

const wallet = buildPopWallet(config.mintUrl, config.unit);
if (PLAYER > 0) {
  const playerToken = await wallet.payPopRequest({ amount: PLAYER, unit: config.unit, mints: [config.mintUrl] });
  await Bun.write(`${outDir}/gudnuf-player-${PLAYER}.token`, playerToken);
}

const prizeToken =
  PRIZE > 0
    ? await wallet.payPopRequest({ amount: PRIZE, unit: config.unit, mints: [config.mintUrl] })
    : "";

const remaining = await localInventory.load(config.mintUrl, config.unit);
const changeToken = getEncodedToken({
  mint: config.mintUrl,
  proofs: remaining,
  unit: config.unit,
});
await Bun.write(`${outDir}/bankroll-next.txt`, changeToken);

console.log(
  JSON.stringify(
    {
      ok: true,
      opening: opening.balance,
      carvedPlayer: 500,
      carvedPrize: 42,
      changeBanked: remaining.reduce((s: number, p) => s + Number(p.amount), 0),
      prizeToken,
    },
    null,
    2,
  ),
);
