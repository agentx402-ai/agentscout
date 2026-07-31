import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout, SpendCapError } from "../src/index";

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());
const AK = `ak_${"a".repeat(64)}`;

function challenge(amount: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          resource: "/v1/scout/read",
          description: "read",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

// Spy on the signer so a test can assert a signature was never PRODUCED — not merely never SENT.
// `signed` (a sent PAYMENT-SIGNATURE header) stays false even if code signed and then failed to
// send, so it can't catch a sign-before-check reorder; `produced` counts the actual EIP-712
// signing. The positive tests assert produced()===1 to prove the spy really observes signing.
function walletWith(opts: Record<string, unknown>, responses: Array<() => Response>) {
  let i = 0,
    signed = false,
    produced = 0;
  const spy = {
    ...signer,
    signTypedData: ((typedData: Parameters<typeof signer.signTypedData>[0]) => {
      produced++;
      return signer.signTypedData(typedData);
    }) as typeof signer.signTypedData,
  } as typeof signer;
  const fetchImpl = (async (_u: any, init?: RequestInit) => {
    if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed = true;
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return {
    client: new AgentScout({ signer: spy, endpoint, fetch: fetchImpl, ...opts }),
    signed: () => signed,
    produced: () => produced,
  };
}

describe("spend caps", () => {
  it("pre-sign: a challenge over maxSpendUsd throws SpendCapError, NO signature produced", async () => {
    const { client, signed, produced } = walletWith({ maxSpendUsd: 0.001 }, [
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("2000") } }), // $0.002 > $0.001
    ]);
    await expect(client.read("https://ex.com")).rejects.toBeInstanceOf(SpendCapError);
    expect(signed()).toBe(false);
    expect(produced()).toBe(0); // no signature was ever produced, not merely unsent
  });

  it("request-build: maxTollUsd that breaches maxSpendUsd throws BEFORE any request", async () => {
    let requested = false;
    const fetchImpl = (async () => {
      requested = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new AgentScout({ signer, endpoint, fetch: fetchImpl, maxSpendUsd: 0.003 });
    await expect(client.read("https://ex.com", { maxTollUsd: 0.01 })).rejects.toBeInstanceOf(
      SpendCapError,
    );
    expect(requested).toBe(false);
  });

  it("account mode + maxTollUsd throws tolls_require_x402 client-side, no request issued", async () => {
    let requested = false;
    const fetchImpl = (async () => {
      requested = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new AgentScout({ accountKey: AK, endpoint, fetch: fetchImpl });
    await expect(client.read("https://ex.com", { maxTollUsd: 0.01 })).rejects.toMatchObject({
      code: "tolls_require_x402",
    });
    expect(requested).toBe(false);
  });

  // --- Authorized-ceiling guard: the primary defense, active even with NO maxSpendUsd set (default). ---

  it("DEFAULT config (no maxSpendUsd): a 402 quoting far above the base price is REFUSED, no signature", async () => {
    // Headline wallet-drain guard: a plain read (base $0.004) whose 402 quotes $1.00 must be refused
    // before signing, even though no explicit cap is configured.
    const { client, signed, produced } = walletWith({}, [
      () =>
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("1000000") } }), // $1.00
    ]);
    await expect(client.read("https://ex.com")).rejects.toBeInstanceOf(SpendCapError);
    expect(signed()).toBe(false);
    expect(produced()).toBe(0);
  });

  it("no maxSpendUsd + maxTollUsd: a 402 above base + sent max_toll_usd is REFUSED, no signature", async () => {
    // Authorized ceiling = base $0.004 + toll $0.02 = $0.024; a $0.50 quote must be refused.
    const { client, signed, produced } = walletWith({}, [
      () =>
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("500000") } }), // $0.50
    ]);
    await expect(client.read("https://ex.com", { maxTollUsd: 0.02 })).rejects.toBeInstanceOf(
      SpendCapError,
    );
    expect(signed()).toBe(false);
    expect(produced()).toBe(0);
  });

  it("no maxSpendUsd: an HONEST quote at exactly the base price is signed (guard does not false-reject)", async () => {
    // 4000 atomic = $0.004 = READ_BASE_USD exactly. This must stay pinned to the REAL scout:read
    // price: it is the regression that catches a client base pinned below the server's quote,
    // which would make the authorized-ceiling guard refuse every honest read.
    // NB: this assertion is only meaningful while the literal EQUALS READ_BASE_USD. If a price
    // change updates the constant but not this literal, the test still passes while silently
    // testing "below base" instead of "at base" — which is exactly the hole it exists to catch.
    const { client, signed, produced } = walletWith({}, [
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("4000") } }), // $0.004 = base
      () =>
        new Response(
          JSON.stringify({ url: "u", markdown: "m", tokens: 1, cache_hit: false, usage: {} }),
          { status: 200 },
        ),
    ]);
    const r = await client.read("https://ex.com");
    expect(r.markdown).toBe("m");
    expect(signed()).toBe(true);
    expect(produced()).toBe(1); // proves the signer spy actually observes signing
  });

  it("maxSessionSpendUsd: first paid read resolves, second is refused at the cap BEFORE signing (one signature total)", async () => {
    // Cap $0.005; each read is base $0.004. After the first ($0.004 spent), a second ($0.004 more)
    // would push cumulative to $0.008 > $0.005 — refused at the session-cap check, after its probe
    // 402 but BEFORE any signature. Fetch script: probe→402, retry→200, probe→402.
    let sigCount = 0;
    let i = 0;
    const responses: Array<() => Response> = [
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("4000") } }),
      () =>
        new Response(
          JSON.stringify({ url: "u", markdown: "m", tokens: 1, cache_hit: false, usage: {} }),
          { status: 200 },
        ),
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("4000") } }),
    ];
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) sigCount++;
      return responses[Math.min(i++, responses.length - 1)]();
    }) as unknown as typeof fetch;
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: fetchImpl,
      maxSessionSpendUsd: 0.005,
    });

    const first = await client.read("https://ex.com");
    expect(first.markdown).toBe("m");
    await expect(client.read("https://ex.com")).rejects.toBeInstanceOf(SpendCapError);
    expect(sigCount).toBe(1); // only the first read ever signed; the second stopped at the cap
  });

  it("maxSessionSpendUsd bounds CONCURRENT reads, not just sequential (reservation, not stale counter)", async () => {
    // Cap $0.005 with three PARALLEL reads at base $0.004: exactly one fits. `recordSpend` only
    // runs after the paid round-trip, so without a synchronous reservation all three checked
    // `0 + 0.004 <= 0.005` against the same stale counter, all three passed, and all three SIGNED
    // — $0.012 of real EIP-3009 authorizations against a $0.005 cap. Reachable through the MCP
    // server, which builds ONE client for its whole lifetime and shares it across parallel
    // tool calls (worst on crawl, which pays maxPages × the per-page price per op).
    //
    // Can't reuse `walletWith`: its ordered response script assumes ops run one at a time, so
    // interleaved probes would consume each other's scripted replies. Key off the header instead.
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: ((typedData: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(typedData);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (!(init && new Headers(init.headers).get("PAYMENT-SIGNATURE"))) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("4000") },
        });
      }
      // Yield so every concurrent op is genuinely in flight across an await boundary — the
      // window in which a stale-counter check would let a sibling through.
      await new Promise((r) => setTimeout(r, 0));
      return new Response(
        JSON.stringify({ url: "u", markdown: "m", tokens: 1, cache_hit: false, usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentScout({
      signer: spy,
      endpoint,
      fetch: fetchImpl,
      maxSessionSpendUsd: 0.005,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => client.read("https://ex.com")),
    );
    const paid = results.filter((r) => r.status === "fulfilled").length;
    const capped = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof SpendCapError,
    ).length;

    // Exact, not an upper bound: toBeLessThanOrEqual(1) would also pass if the reservation
    // over-counted so badly that NOTHING got through. Pin the right answer ($0.004 <= $0.005;
    // a second $0.004 breaches). `produced` is the load-bearing one — it counts signatures
    // actually PRODUCED, so it catches a sign-then-fail-to-send reorder that `paid` cannot.
    expect(produced).toBe(1);
    expect(paid).toBe(1);
    expect(capped).toBe(2);
  });

  it("sequential spend is unchanged: two reads under a $0.009 cap both pay (reservation is released)", async () => {
    // Guards the other half of the reservation: a leaked (never released) reservation would
    // permanently consume budget and starve legitimate sequential ops. Two $0.004 reads must
    // still fit a $0.009 cap, which they only do if the first op's reservation was released
    // and replaced by its $0.004 settled spend rather than double-counting as $0.008.
    let sigCount = 0;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (!(init && new Headers(init.headers).get("PAYMENT-SIGNATURE"))) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("4000") },
        });
      }
      sigCount++;
      return new Response(
        JSON.stringify({ url: "u", markdown: "m", tokens: 1, cache_hit: false, usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: fetchImpl,
      maxSessionSpendUsd: 0.009,
    });

    expect((await client.read("https://ex.com")).markdown).toBe("m");
    expect((await client.read("https://ex.com")).markdown).toBe("m");
    expect(sigCount).toBe(2);
    // A third would push cumulative to $0.012 > $0.009 — still refused.
    await expect(client.read("https://ex.com")).rejects.toBeInstanceOf(SpendCapError);
    expect(sigCount).toBe(2);
  });

  it("a FAILED paid op releases its reservation without charging the session cap", async () => {
    // The `finally` half: when the paid retry comes back non-ok, `recordSpend` never runs, so the
    // reservation must be released or the budget is burned by an op that was never charged. A
    // $0.005 cap admits exactly one $0.004 read; after a failed one, the next must still fit.
    let attempt = 0;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (!(init && new Headers(init.headers).get("PAYMENT-SIGNATURE"))) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("4000") },
        });
      }
      // First paid attempt fails upstream (nothing settles); the second succeeds.
      if (++attempt === 1) {
        return new Response(JSON.stringify({ error: "upstream", code: "upstream_unavailable" }), {
          status: 503,
        });
      }
      return new Response(
        JSON.stringify({ url: "u", markdown: "m", tokens: 1, cache_hit: false, usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: fetchImpl,
      // retries: 0 so the 503 surfaces instead of being retried away by the transport layer.
      retries: 0,
      maxSessionSpendUsd: 0.005,
    });

    await expect(client.read("https://ex.com")).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    // The failed op charged nothing, so the cap still has room for a full $0.004 read.
    expect((await client.read("https://ex.com")).markdown).toBe("m");
  });

  it("no maxSpendUsd + maxTollUsd: an HONEST quote at exactly base + toll is signed (boundary, no false-reject)", async () => {
    // base $0.004 (4000) + toll $0.02 (20000) = 24000 atomic = $0.024 — the EXACT authorized
    // ceiling. Must be signed, not refused (PRICE_EPS absorbs float). Quoting below the ceiling
    // (the old 22000) would not exercise the boundary the sibling at-base test's comment warns of.
    const { client, signed, produced } = walletWith({}, [
      () =>
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("24000") } }),
      () =>
        new Response(
          JSON.stringify({
            url: "u",
            markdown: "m",
            tokens: 1,
            cache_hit: false,
            toll: { toll_paid_atomic: 20000, tx_hash: "0xabc", rail: "x402" },
          }),
          { status: 200 },
        ),
    ]);
    const r = await client.read("https://ex.com", { maxTollUsd: 0.02 });
    expect((r as { toll?: unknown }).toll).toBeTruthy();
    expect(signed()).toBe(true);
    expect(produced()).toBe(1);
  });

  // --- Fail-CLOSED comparison polarity (defense in depth at the signing choke point) ---
  //
  // White-box on purpose. These guards are the last gates before a signature, so a non-finite
  // amount must be REFUSED rather than waved through by a vacuous `NaN > cap` (always false).
  // No PUBLIC input can produce a NaN here today — caps are validated at construction and
  // `@agentx402-ai/core` pins the challenge amount to /^[0-9]+$/ — so the protected guards are
  // driven directly. The point is that they stay safe if a future call path ever loses that
  // guarantee; a guard whose safety depends on a caller three layers up is not a guard.
  class Probe extends AgentScout {
    spend(usd: number) {
      this.assertSpend(usd);
    }
    opCeiling(usd: number) {
      this.assertOpPriceCeiling(usd);
    }
  }

  it("assertSpend fails CLOSED on a non-finite amount vs the per-call cap", () => {
    const p = new Probe({ signer, endpoint, maxSpendUsd: 0.01 });
    expect(() => p.spend(Number.NaN)).toThrow(SpendCapError);
    expect(() => p.spend(Number.POSITIVE_INFINITY)).toThrow(SpendCapError);
    expect(() => p.spend(0.004)).not.toThrow(); // an honest amount still passes
  });

  it("assertSpend fails CLOSED on a non-finite amount vs the session cap", () => {
    const p = new Probe({ signer, endpoint, maxSessionSpendUsd: 0.01 });
    expect(() => p.spend(Number.NaN)).toThrow(SpendCapError);
  });

  it("assertOpPriceCeiling fails CLOSED on a non-finite quote in the default config", () => {
    const p = new Probe({ signer, endpoint });
    expect(() => p.opCeiling(Number.NaN)).toThrow(SpendCapError);
    expect(() => p.opCeiling(0.004)).not.toThrow();
  });
});
