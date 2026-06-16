/**
 * The browser pop wallet: a localStorage inventory + a cashu-ts-backed payer.
 *
 * The cashu-ts machinery (exact-amount NUT-03 swap via `Wallet.send`, the
 * v2-short-keyset `normalizePopProofIds` fix) is REUSED from
 * `@mpp-jams/fetch-with-pop`'s `createCashuPopWallet`, keeping the parts
 * the contract needs alive. (Its old flat 402 envelope is dead and
 * not imported; the wire lives in `charge01.ts`.)
 *
 * Storage patterns (denormalized number amounts, consume-once commit,
 * tolerant cashuB decode incl. the cdk short-keyset-id workaround) are ported
 * from the proven iframe-wallet (`iframe-wallet/src/wallet/{storage,wallet}.ts`).
 *
 * Mint URL + unit are RUNTIME values (from the server's /api/config, which
 * read them from the mint's /v1/keysets), never compiled in.
 */

import {
  Wallet,
  Mint,
  decodePaymentRequest,
  getEncodedToken,
  getDecodedToken,
  type Proof,
} from "@cashu/cashu-ts";
import {
  createCashuPopWallet,
  type PopInventoryStore,
  type PopWallet,
} from "@mpp-jams/fetch-with-pop";

/** Stored proof: plain-number `amount` (cashu-ts `Amount` does not survive JSON). */
export interface StoredProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  [k: string]: unknown;
}

const INVENTORY_KEY = "bazaar:inventory";

type InventoryMap = Record<string, StoredProof[]>;

const slot = (mintUrl: string, unit: string): string => `${mintUrl}\n${unit}`;

const readMap = (): InventoryMap => {
  const raw = localStorage.getItem(INVENTORY_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as InventoryMap;
  } catch {
    return {};
  }
};

const writeMap = (map: InventoryMap): void => {
  localStorage.setItem(INVENTORY_KEY, JSON.stringify(map));
};

const amountToNumber = (a: number | { toNumber(): number }): number =>
  typeof a === "number" ? a : a.toNumber();

const denormalize = (proofs: Proof[]): StoredProof[] =>
  proofs.map((p) => ({
    ...(p as unknown as Record<string, unknown>),
    id: p.id,
    secret: p.secret,
    C: p.C,
    amount: amountToNumber(p.amount as unknown as number | { toNumber(): number }),
  }));

/** The consume-once inventory the cashu pop wallet swaps against. */
export const localInventory: PopInventoryStore = {
  load(mintUrl: string, unit: string): Proof[] {
    return (readMap()[slot(mintUrl, unit)] ?? []) as unknown as Proof[];
  },
  commit(mintUrl: string, unit: string, keep: Proof[], _spent: Proof[]): void {
    const map = readMap();
    map[slot(mintUrl, unit)] = denormalize(keep);
    writeMap(map);
  },
};

export const getBalance = (
  mintUrl: string,
  unit: string,
): { balance: number; proofCount: number } => {
  const proofs = readMap()[slot(mintUrl, unit)] ?? [];
  return {
    balance: proofs.reduce((sum, p) => sum + p.amount, 0),
    proofCount: proofs.length,
  };
};

export const addProofs = (
  mintUrl: string,
  unit: string,
  proofs: Proof[],
): void => {
  const map = readMap();
  const key = slot(mintUrl, unit);
  map[key] = [...(map[key] ?? []), ...denormalize(proofs)];
  writeMap(map);
};

/* --------------- tolerant cashuB decode (cdk short keyset ids) ------------ */

/**
 * Pull keyset-id bytestrings (`t[].i`) out of a cashuB token's CBOR: a
 * minimal walk, no CBOR library. Ported from the proven iframe-wallet (which
 * ported it from the extension SW). Needed because cashu-ts
 * `getDecodedToken` throws on a cdk pop token carrying a v2 SHORT keyset id
 * unless seeded with keysetIds to expand against; the token's own ids
 * self-map.
 */
export const keysetIdsFromCashuB = (token: string): string[] => {
  const b64 = token
    .slice("cashuB".length)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const ids = new Set<string>();
  const td = new TextDecoder();
  let p = 0;
  let lastKey: string | null = null;

  const readLen = (ai: number): number => {
    if (ai < 24) return ai;
    if (ai === 24) return bytes[p++] as number;
    if (ai === 25) {
      const v = ((bytes[p] as number) << 8) | (bytes[p + 1] as number);
      p += 2;
      return v;
    }
    if (ai === 26) {
      const v =
        (((bytes[p] as number) << 24) |
          ((bytes[p + 1] as number) << 16) |
          ((bytes[p + 2] as number) << 8) |
          (bytes[p + 3] as number)) >>>
        0;
      p += 4;
      return v;
    }
    throw new Error("unsupported CBOR length");
  };

  const walk = (): void => {
    const ib = bytes[p++] as number;
    const major = ib >> 5;
    const ai = ib & 0x1f;
    switch (major) {
      case 0:
      case 1:
        readLen(ai);
        return;
      case 2: {
        const n = readLen(ai);
        const slice = bytes.subarray(p, p + n);
        p += n;
        if (lastKey === "i") {
          ids.add([...slice].map((b) => b.toString(16).padStart(2, "0")).join(""));
        }
        return;
      }
      case 3: {
        const n = readLen(ai);
        lastKey = td.decode(bytes.subarray(p, p + n));
        p += n;
        return;
      }
      case 4: {
        const n = readLen(ai);
        for (let k = 0; k < n; k++) walk();
        return;
      }
      case 5: {
        const n = readLen(ai);
        for (let k = 0; k < n; k++) {
          walk();
          walk();
          lastKey = null;
        }
        return;
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  };

  walk();
  return [...ids];
};

/** Decode a cashuB token, tolerating a v2 short keyset id (see above). */
export const decodeTokenTolerant = (
  token: string,
): ReturnType<typeof getDecodedToken> => {
  try {
    return getDecodedToken(token, []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/short keyset id/i.test(msg)) throw err;
    return getDecodedToken(token, keysetIdsFromCashuB(token));
  }
};

/**
 * Import a pasted cashuB into this origin's inventory. The wallet's
 * (mintUrl, unit) slot is authoritative; the embedded mint URL is a hint,
 * the unit must match the active one or the verifier would reject it anyway.
 */
export const importToken = (
  token: string,
  mintUrl: string,
  unit: string,
): { added: number } => {
  const decoded = decodeTokenTolerant(token.trim());
  if (decoded.unit && decoded.unit !== unit) {
    throw new Error(
      `token unit "${decoded.unit}" does not match the active unit "${unit}"`,
    );
  }
  if (!decoded.proofs?.length) {
    throw new Error("token carries no proofs");
  }
  addProofs(mintUrl, unit, decoded.proofs);
  const added = decoded.proofs.reduce(
    (sum, p) => sum + amountToNumber(p.amount as unknown as number),
    0,
  );
  return { added };
};

/**
 * Build the PopWallet (exact-amount splitter): decodes creqA, swaps to
 * EXACTLY the requested amount against the mint (overpay would be RETAINED
 * by the verifier (never present more), commits the remainder.
 */
export const buildPopWallet = (mintUrl: string, unit: string): PopWallet => {
  const wallet = new Wallet(new Mint(mintUrl), { unit });
  return createCashuPopWallet({
    wallet,
    inventory: localInventory,
    decodePaymentRequest,
    getEncodedToken,
  });
};
