/**
 * Wallet inventory: consume-once commit, denormalized amounts, the
 * exact-amount pay path through fetch-with-pop's createCashuPopWallet with a
 * stub cashu-ts wallet (the live-mint swap is the money-leg E2E's job).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Proof } from "@cashu/cashu-ts";
import { createCashuPopWallet } from "@mpp-jams/fetch-with-pop";
import {
  addProofs,
  getBalance,
  keysetIdsFromCashuB,
  localInventory,
} from "../src/wallet.ts";

// bun:test has no DOM; give the module the storage it expects.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as Storage;

const MINT = "http://127.0.0.1:28338";
const UNIT = "pop_1700000000";

const proof = (amount: number, n: number): Proof =>
  ({
    id: "01aabbccddeeff00",
    amount,
    secret: `secret-${n}`,
    C: `c-${n}`,
  }) as unknown as Proof;

beforeEach(() => store.clear());

describe("inventory", () => {
  test("addProofs accrues and getBalance sums", () => {
    addProofs(MINT, UNIT, [proof(8, 1), proof(2, 2)]);
    addProofs(MINT, UNIT, [proof(4, 3)]);
    expect(getBalance(MINT, UNIT)).toEqual({ balance: 14, proofCount: 3 });
    // Slots are (mint, unit)-scoped.
    expect(getBalance(MINT, "pop_other")).toEqual({ balance: 0, proofCount: 0 });
  });

  test("commit replaces the slot (consume-once: spent proofs vanish)", () => {
    addProofs(MINT, UNIT, [proof(8, 1), proof(2, 2)]);
    localInventory.commit(MINT, UNIT, [proof(2, 2)], [proof(8, 1)]);
    const left = localInventory.load(MINT, UNIT) as unknown as Array<{ secret: string }>;
    expect(left.map((p) => p.secret)).toEqual(["secret-2"]);
    expect(getBalance(MINT, UNIT).balance).toBe(2);
  });

  test("amounts are stored as plain numbers even when given Amount-like objects", () => {
    const amountLike = { toNumber: () => 16 } as unknown as number;
    addProofs(MINT, UNIT, [
      { ...proof(0, 9), amount: amountLike } as unknown as Proof,
    ]);
    const raw = JSON.parse(store.get("bazaar:inventory")!);
    expect(raw[`${MINT}\n${UNIT}`][0].amount).toBe(16);
  });
});

describe("pay path (stubbed cashu-ts wallet)", () => {
  const stubWallet = {
    mint: { mintUrl: MINT },
    unit: UNIT,
    loadMint: async () => {},
    // Exact-amount split: send sums to amount, keep is the remainder.
    send: async (amount: number, proofs: Proof[]) => {
      const total = proofs.reduce((s, p) => s + (p.amount as unknown as number), 0);
      if (total < amount) throw new Error("insufficient");
      return {
        send: [proof(amount, 100)],
        keep: total - amount > 0 ? [proof(total - amount, 101)] : [],
      };
    },
  };

  const wallet = createCashuPopWallet({
    wallet: stubWallet,
    inventory: localInventory,
    decodePaymentRequest: () => ({ amount: 50, unit: UNIT, mints: [MINT] }),
    getEncodedToken: (t) =>
      `cashuB-stub:${t.proofs.reduce((s, p) => s + (p.amount as unknown as number), 0)}`,
  });

  test("pays exactly the amount and debits inventory atomically", async () => {
    addProofs(MINT, UNIT, [proof(64, 1)]);
    const request = await wallet.decodeRequest("creqA-stub");
    expect(request).toEqual({ amount: 50, unit: UNIT, mints: [MINT] });
    const token = await wallet.payPopRequest(request);
    expect(token).toBe("cashuB-stub:50"); // EXACT — overpay would be retained
    expect(getBalance(MINT, UNIT).balance).toBe(14); // 64 - 50 stays home
  });

  test("refuses to pay beyond inventory", async () => {
    addProofs(MINT, UNIT, [proof(8, 1)]);
    await expect(
      wallet.payPopRequest({ amount: 50, unit: UNIT, mints: [MINT] }),
    ).rejects.toThrow(/insufficient/);
    expect(getBalance(MINT, UNIT).balance).toBe(8); // nothing burned
  });
});

describe("cashuB CBOR keyset-id walk", () => {
  test("extracts t[].i byte strings from a hand-built CBOR token", () => {
    // {"t":[{"i": h'0102', "p":[]}]} — minimal structure with an "i" bytestring.
    const cbor = new Uint8Array([
      0xa1, // map(1)
      0x61, 0x74, // "t"
      0x81, // array(1)
      0xa2, // map(2)
      0x61, 0x69, // "i"
      0x42, 0x01, 0x02, // bytes(2) 0102
      0x61, 0x70, // "p"
      0x80, // array(0)
    ]);
    const b64 = Buffer.from(cbor).toString("base64url");
    expect(keysetIdsFromCashuB(`cashuB${b64}`)).toEqual(["0102"]);
  });
});
