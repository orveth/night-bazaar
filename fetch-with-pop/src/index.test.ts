import { describe, it, expect, vi } from "vitest";
import {
  fetchWithPop,
  popPaymentHandler,
  createCashuPopWallet,
  paymentEnvelope,
  jcs,
  encodeBase64url,
  decodeBase64url,
  encodePopRequest,
  makePopWwwAuthenticateHeader,
  decodePopCredential,
  type PopWallet,
  type PopRequest,
  type PopInventoryStore,
  type CashuTsWalletLike,
} from "./index.js";

// A NUT-18-ish creqA placeholder. Real decode is the cashu-ts wallet's job;
// the envelope only carries it opaquely.
const CREQ = "creqApXlk...stub";
const UNIT = "pop_1782668279";
const MINT = "https://mint.test";

/** Build a 402 Response carrying a pop Payment challenge. */
const make402 = (opts?: { request?: string; method?: string; id?: string }) => {
  const request = opts?.request ?? encodePopRequest(CREQ);
  let header: string;
  if (opts?.method && opts.method !== "cashu") {
    header =
      `Payment id="${opts?.id ?? "chal-1"}", realm="api", method="${opts.method}",` +
      ` intent="charge", request="${request}"`;
  } else {
    header = makePopWwwAuthenticateHeader({
      id: opts?.id ?? "chal-1",
      realm: "api",
      request,
    });
  }
  return new Response("payment required", {
    status: 402,
    headers: { "www-authenticate": header, "cache-control": "no-store" },
  });
};

/** A stub PopWallet that records calls and returns a fixed token. */
const stubWallet = (overrides?: Partial<PopWallet>): PopWallet & {
  paid: PopRequest[];
} => {
  const paid: PopRequest[] = [];
  return {
    paid,
    decodeRequest: (_cashuRequest: string): PopRequest => ({
      amount: 5,
      unit: UNIT,
      mints: [MINT],
    }),
    payPopRequest: async (req: PopRequest): Promise<string> => {
      paid.push(req);
      return "cashuBstub-token";
    },
    ...overrides,
  };
};

describe("402 detection", () => {
  it("detects a pop cashu Payment challenge", () => {
    const c = paymentEnvelope.detect(make402());
    expect(c).not.toBeNull();
    expect(c?.method).toBe("cashu");
    expect(c?.intent).toBe("charge");
    expect(c?.id).toBe("chal-1");
    expect(c?.realm).toBe("api");
  });

  it("returns null for a non-402-payment (no www-authenticate)", () => {
    const r = new Response("ok", { status: 200 });
    expect(paymentEnvelope.detect(r)).toBeNull();
  });

  it("returns null for a lightning method (wrong method falls through)", () => {
    expect(paymentEnvelope.detect(make402({ method: "lightning" }))).toBeNull();
  });

  it("returns null for an L402 scheme header", () => {
    const r = new Response("", {
      status: 402,
      headers: { "www-authenticate": 'L402 macaroon="abc", invoice="lnbc1..."' },
    });
    expect(paymentEnvelope.detect(r)).toBeNull();
  });

  it("fetchWithPop returns a non-402 response untouched", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello", { status: 200 }));
    const res = await fetchWithPop("https://api.test/x", undefined, {
      wallet: stubWallet(),
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("challenge parse", () => {
  it("parses all auth-params including optional expires", () => {
    const header = makePopWwwAuthenticateHeader({
      id: "id-9",
      realm: "my realm",
      request: encodePopRequest(CREQ),
      expires: "2026-05-29T00:00:00Z",
    });
    const r = new Response("", { status: 402, headers: { "www-authenticate": header } });
    const c = paymentEnvelope.detect(r);
    expect(c?.id).toBe("id-9");
    expect(c?.realm).toBe("my realm");
    expect(c?.expires).toBe("2026-05-29T00:00:00Z");
  });

  it("omits expires when not present", () => {
    const c = paymentEnvelope.detect(make402());
    expect(c && "expires" in c).toBe(false);
  });

  it("extracts the inner creqA from the request auth-param", () => {
    const c = paymentEnvelope.detect(make402())!;
    expect(paymentEnvelope.requestFrom(c)).toBe(CREQ);
  });

  it("throws on a request param that is not base64url JSON", () => {
    const c = paymentEnvelope.detect(make402({ request: "!!!not-base64!!!" }))!;
    expect(() => paymentEnvelope.requestFrom(c)).toThrow(/base64url/);
  });

  it("throws when decoded request lacks cashu_request", () => {
    const bad = encodeBase64url(jcs({ something_else: "x" }));
    const c = paymentEnvelope.detect(make402({ request: bad }))!;
    expect(() => paymentEnvelope.requestFrom(c)).toThrow(/cashu_request/);
  });

  it("rejects a challenge missing required params (no realm)", () => {
    const header = `Payment id="x", method="cashu", intent="charge", request="${encodePopRequest(CREQ)}"`;
    const r = new Response("", { status: 402, headers: { "www-authenticate": header } });
    expect(paymentEnvelope.detect(r)).toBeNull();
  });
});

describe("JCS canonical encode / round-trip", () => {
  it("sorts object keys lexicographically at every level", () => {
    expect(jcs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(jcs({ z: { y: 1, x: 2 }, a: [3, { d: 1, c: 2 }] })).toBe(
      '{"a":[3,{"c":2,"d":1}],"z":{"x":2,"y":1}}',
    );
  });

  it("emits compact JSON (no whitespace)", () => {
    expect(jcs({ a: 1, b: [1, 2, 3] })).toBe('{"a":1,"b":[1,2,3]}');
  });

  it("base64url round-trips arbitrary UTF-8 without padding", () => {
    const s = '{"emoji":"⚡","n":42}';
    const enc = encodeBase64url(s);
    expect(enc).not.toMatch(/[+/=]/);
    expect(decodeBase64url(enc)).toBe(s);
  });

  it("builds an Authorization credential that the verifier can decode", () => {
    const c = paymentEnvelope.detect(make402({ id: "abc", request: encodePopRequest(CREQ) }))!;
    const headers = new Headers();
    paymentEnvelope.applyPayment(c, headers, { cashuToken: "cashuBxyz" });

    const auth = headers.get("Authorization")!;
    expect(auth.startsWith("Payment ")).toBe(true);

    const cred = decodePopCredential(auth);
    // challenge echo
    expect(cred.challenge.id).toBe("abc");
    expect(cred.challenge.method).toBe("cashu");
    expect(cred.challenge.intent).toBe("charge");
    expect(cred.challenge.realm).toBe("api");
    expect(cred.challenge.request).toBe(encodePopRequest(CREQ));
    // payload carries the cashu token (not a preimage)
    expect(cred.payload.token).toBe("cashuBxyz");
  });

  it("credential is JCS-canonical (challenge keys sorted, payload present)", () => {
    const c = paymentEnvelope.detect(make402({ id: "abc" }))!;
    const headers = new Headers();
    paymentEnvelope.applyPayment(c, headers, { cashuToken: "T" });
    const token = headers.get("Authorization")!.slice("Payment ".length);
    const canonical = decodeBase64url(token);
    // top-level keys sorted: challenge before payload; challenge inner keys sorted
    expect(canonical).toBe(
      '{"challenge":{"id":"abc","intent":"charge","method":"cashu","realm":"api","request":"' +
        encodePopRequest(CREQ) +
        '"},"payload":{"token":"T"}}',
    );
  });

  it("includes expires in the echo when the challenge had it", () => {
    const header = makePopWwwAuthenticateHeader({
      id: "abc",
      realm: "api",
      request: encodePopRequest(CREQ),
      expires: "2026-12-31T00:00:00Z",
    });
    const r = new Response("", { status: 402, headers: { "www-authenticate": header } });
    const c = paymentEnvelope.detect(r)!;
    const headers = new Headers();
    paymentEnvelope.applyPayment(c, headers, { cashuToken: "T" });
    const cred = decodePopCredential(headers.get("Authorization")!);
    expect(cred.challenge.expires).toBe("2026-12-31T00:00:00Z");
  });
});

describe("happy-path pay + retry", () => {
  it("pays a 402 and retries the SAME request with the credential", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (input: any, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? undefined);
      calls.push({ url: String(input), auth: headers.get("Authorization") });
      if (calls.length === 1) return make402();
      return new Response("paid-content", { status: 200 });
    });

    const wallet = stubWallet();
    const res = await fetchWithPop("https://api.test/resource", undefined, {
      wallet,
      fetchImpl,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("paid-content");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // first call: no auth; retry: Payment credential
    expect(calls[0].auth).toBeNull();
    expect(calls[1].auth?.startsWith("Payment ")).toBe(true);
    // wallet was asked to pay exactly the decoded request
    expect(wallet.paid).toHaveLength(1);
    expect(wallet.paid[0]).toEqual({ amount: 5, unit: UNIT, mints: [MINT] });
  });

  it("forces cache:no-store on the initial fetch (consume-once)", async () => {
    let seenCache: RequestCache | undefined;
    const fetchImpl = vi.fn(async (_i: any, init?: RequestInit) => {
      seenCache = init?.cache;
      return new Response("ok", { status: 200 });
    });
    await fetchWithPop("https://api.test/x", { cache: "force-cache" }, {
      wallet: stubWallet(),
      fetchImpl,
    });
    expect(seenCache).toBe("no-store");
  });

  it("enforces maxAmount before paying", async () => {
    const fetchImpl = vi.fn(async () => make402());
    const wallet = stubWallet();
    await expect(
      fetchWithPop("https://api.test/x", undefined, {
        wallet,
        maxAmount: 4, // request is 5
        fetchImpl,
      }),
    ).rejects.toThrow(/exceeds maxAmount/);
    expect(wallet.paid).toHaveLength(0); // never swapped
  });
});

describe("infinite-loop guard", () => {
  it("throws if the retry would re-send an already-paid request", async () => {
    // Server keeps returning 402 even after payment -> must bail, not loop.
    const fetchImpl = vi.fn(async () => make402());
    await expect(
      fetchWithPop("https://api.test/x", undefined, {
        wallet: stubWallet(),
        fetchImpl,
      }),
    ).rejects.toThrow(/already attempted|retry loop/i);
    // initial fetch + one paid retry, then guard stops it (no third call);
    // a second swap is never performed.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("popPaymentHandler bails when init already carries Payment auth", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const resp = make402();
    await expect(
      popPaymentHandler(
        "https://api.test/x",
        { headers: { Authorization: "Payment alreadyhere" } },
        resp,
        { wallet: stubWallet(), fetchImpl },
      ),
    ).rejects.toThrow(/already attempted|retry loop/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("popPaymentHandler returns the original response when no challenge", async () => {
    const ok = new Response("ok", { status: 200 });
    const fetchImpl = vi.fn();
    const out = await popPaymentHandler("https://api.test/x", undefined, ok, {
      wallet: stubWallet(),
      fetchImpl,
    });
    expect(out).toBe(ok);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("exact-amount token selection (createCashuPopWallet, mocked mint/swap)", () => {
  // Minimal fake proofs; amount is a number here (cashu-ts accepts AmountLike).
  const proof = (amount: number, secret: string) =>
    ({ id: "ks1", amount, secret, C: "02deadbeef" }) as any;

  /** A fake cashu-ts Wallet whose send() splits exact-amount from inventory. */
  const fakeCashuWallet = (held: number[]): CashuTsWalletLike & {
    sendCalls: Array<{ amount: number; proofCount: number }>;
  } => {
    const sendCalls: Array<{ amount: number; proofCount: number }> = [];
    return {
      mint: { mintUrl: MINT },
      unit: UNIT,
      sendCalls,
      loadMint: async () => {},
      send: async (amount: number, proofs: any[]) => {
        sendCalls.push({ amount, proofCount: proofs.length });
        // Simulate a NUT-03 swap: produce one proof of EXACTLY `amount`,
        // keep the rest as change.
        const total = proofs.reduce((s, p) => s + Number(p.amount), 0);
        if (total < amount) throw new Error("insufficient");
        return {
          send: [proof(amount, "sent-secret")],
          keep:
            total - amount > 0 ? [proof(total - amount, "change-secret")] : [],
        };
      },
    };
  };

  const memoryStore = (initial: any[]): PopInventoryStore & {
    state: any[];
    committed: Array<{ keep: any[]; spent: any[] }>;
  } => {
    let state = initial;
    const committed: Array<{ keep: any[]; spent: any[] }> = [];
    return {
      get state() {
        return state;
      },
      committed,
      load: () => state,
      commit: (_m, _u, keep, spent) => {
        committed.push({ keep, spent });
        state = keep; // consume-once: remainder replaces inventory
      },
    };
  };

  const decodeReq = (_creq: string) => ({
    amount: 5,
    unit: UNIT,
    mints: [MINT],
  });
  const encodeTok = (t: { mint: string; proofs: any[]; unit?: string }) =>
    `cashuB:${t.unit}:${t.proofs.map((p) => p.amount).join("+")}`;

  it("swaps to an exact-amount token and keeps the remainder", async () => {
    const wallet = fakeCashuWallet([10]); // one 10-unit proof held
    const store = memoryStore([proof(10, "held-secret")]);
    const popWallet = createCashuPopWallet({
      wallet,
      inventory: store,
      decodePaymentRequest: decodeReq,
      getEncodedToken: encodeTok,
    });

    const req = await popWallet.decodeRequest(CREQ);
    expect(req).toEqual({ amount: 5, unit: UNIT, mints: [MINT] });

    const token = await popWallet.payPopRequest(req);
    // produced a token of EXACTLY 5
    expect(token).toBe(`cashuB:${UNIT}:5`);
    expect(wallet.sendCalls).toEqual([{ amount: 5, proofCount: 1 }]);
    // consume-once: committed remainder (5) replaced inventory; spent proof gone
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0].spent.map((p: any) => p.amount)).toEqual([5]);
    expect(store.state.map((p: any) => p.amount)).toEqual([5]);
  });

  it("rejects when held inventory is insufficient", async () => {
    const wallet = fakeCashuWallet([3]);
    const store = memoryStore([proof(3, "held")]);
    const popWallet = createCashuPopWallet({
      wallet,
      inventory: store,
      decodePaymentRequest: decodeReq,
      getEncodedToken: encodeTok,
    });
    await expect(
      popWallet.payPopRequest({ amount: 5, unit: UNIT, mints: [MINT] }),
    ).rejects.toThrow(/insufficient pop inventory/);
    expect(store.committed).toHaveLength(0); // nothing spent
  });

  it("rejects a unit mismatch (sat wallet cannot pay a pop request)", async () => {
    const wallet = { ...fakeCashuWallet([10]), unit: "sat" };
    const store = memoryStore([proof(10, "held")]);
    const popWallet = createCashuPopWallet({
      wallet,
      inventory: store,
      decodePaymentRequest: decodeReq,
      getEncodedToken: encodeTok,
    });
    await expect(
      popWallet.payPopRequest({ amount: 5, unit: UNIT, mints: [MINT] }),
    ).rejects.toThrow(/does not match requested unit/);
  });

  it("rejects when held mint is not among the request's accepted mints", async () => {
    const wallet = fakeCashuWallet([10]);
    const store = memoryStore([proof(10, "held")]);
    const popWallet = createCashuPopWallet({
      wallet,
      inventory: store,
      decodePaymentRequest: decodeReq,
      getEncodedToken: encodeTok,
    });
    await expect(
      popWallet.payPopRequest({
        amount: 5,
        unit: UNIT,
        mints: ["https://other-mint.test"],
      }),
    ).rejects.toThrow(/not among the request's accepted mints/);
  });

  it("decodeRequest pulls amount/unit/mints from cashu-ts decodePaymentRequest", async () => {
    // Amount may arrive as an Amount-like object with toNumber().
    const popWallet = createCashuPopWallet({
      wallet: fakeCashuWallet([10]),
      inventory: memoryStore([]),
      decodePaymentRequest: () => ({
        amount: { toNumber: () => 7 },
        unit: UNIT,
        mints: [MINT],
      }),
      getEncodedToken: encodeTok,
    });
    const req = await popWallet.decodeRequest(CREQ);
    expect(req.amount).toBe(7);
    expect(req.unit).toBe(UNIT);
  });

  it("rejects a request with no positive amount", async () => {
    const popWallet = createCashuPopWallet({
      wallet: fakeCashuWallet([10]),
      inventory: memoryStore([]),
      decodePaymentRequest: () => ({ amount: 0, unit: UNIT, mints: [MINT] }),
      getEncodedToken: encodeTok,
    });
    // createCashuPopWallet.decodeRequest is synchronous, so it throws directly.
    expect(() => popWallet.decodeRequest(CREQ)).toThrow(/positive amount/);
  });
});

describe("end-to-end with createCashuPopWallet wired into fetchWithPop", () => {
  const proof = (amount: number, secret: string) =>
    ({ id: "ks1", amount, secret, C: "02ab" }) as any;

  it("auto-pays a 402 using a cashu-ts-backed wallet and a mocked swap", async () => {
    // mocked mint/swap
    const cashuWallet: CashuTsWalletLike = {
      mint: { mintUrl: MINT },
      unit: UNIT,
      loadMint: async () => {},
      send: async (amount: number, proofs: any[]) => {
        const total = proofs.reduce((s, p) => s + Number(p.amount), 0);
        return {
          send: [proof(amount, "s")],
          keep: total - amount > 0 ? [proof(total - amount, "c")] : [],
        };
      },
    };
    let inv = [proof(21, "held")];
    const popWallet = createCashuPopWallet({
      wallet: cashuWallet,
      inventory: {
        load: () => inv,
        commit: (_m, _u, keep) => {
          inv = keep;
        },
      },
      decodePaymentRequest: () => ({ amount: 8, unit: UNIT, mints: [MINT] }),
      getEncodedToken: (t) => `cashuB:${t.proofs.map((p: any) => p.amount).join("+")}`,
    });

    const fetchImpl = vi.fn(async (_i: any, init?: RequestInit) => {
      const auth = new Headers(init?.headers ?? undefined).get("Authorization");
      if (!auth) return make402();
      // verifier-side: decode the credential, check the token is worth 8
      const cred = decodePopCredential(auth);
      expect(cred.payload.token).toBe("cashuB:8");
      return new Response("granted", { status: 200 });
    });

    const res = await fetchWithPop("https://api.test/paywalled", undefined, {
      wallet: popWallet,
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("granted");
    // remainder kept: 21 - 8 = 13
    expect(inv.map((p) => p.amount)).toEqual([13]);
  });
});
