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

function walletWith(opts: Record<string, unknown>, responses: Array<() => Response>) {
  let i = 0,
    signed = false;
  const fetchImpl = (async (_u: any, init?: RequestInit) => {
    if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed = true;
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return {
    client: new AgentScout({ signer, endpoint, fetch: fetchImpl, ...opts }),
    signed: () => signed,
  };
}

describe("spend caps", () => {
  it("pre-sign: a challenge over maxSpendUsd throws SpendCapError, NO signature produced", async () => {
    const { client, signed } = walletWith({ maxSpendUsd: 0.001 }, [
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("2000") } }), // $0.002 > $0.001
    ]);
    await expect(client.read("https://ex.com")).rejects.toBeInstanceOf(SpendCapError);
    expect(signed()).toBe(false);
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
    // Headline wallet-drain guard: a plain read (base $0.002) whose 402 quotes $1.00 must be refused
    // before signing, even though no explicit cap is configured.
    const { client, signed } = walletWith({}, [
      () =>
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("1000000") } }), // $1.00
    ]);
    await expect(client.read("https://ex.com")).rejects.toBeInstanceOf(SpendCapError);
    expect(signed()).toBe(false);
  });

  it("no maxSpendUsd + maxTollUsd: a 402 above base + sent max_toll_usd is REFUSED, no signature", async () => {
    // Authorized ceiling = base $0.002 + toll $0.02 = $0.022; a $0.50 quote must be refused.
    const { client, signed } = walletWith({}, [
      () =>
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("500000") } }), // $0.50
    ]);
    await expect(client.read("https://ex.com", { maxTollUsd: 0.02 })).rejects.toBeInstanceOf(
      SpendCapError,
    );
    expect(signed()).toBe(false);
  });

  it("no maxSpendUsd: an HONEST quote at exactly the base price is signed (guard does not false-reject)", async () => {
    const { client, signed } = walletWith({}, [
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("2000") } }), // $0.002 = base
      () =>
        new Response(
          JSON.stringify({ url: "u", markdown: "m", tokens: 1, cache_hit: false, usage: {} }),
          { status: 200 },
        ),
    ]);
    const r = await client.read("https://ex.com");
    expect(r.markdown).toBe("m");
    expect(signed()).toBe(true);
  });

  it("maxSessionSpendUsd: first paid read resolves, second is refused at the cap BEFORE signing (one signature total)", async () => {
    // Cap $0.003; each read is base $0.002. After the first ($0.002 spent), a second ($0.002 more)
    // would push cumulative to $0.004 > $0.003 — refused at the session-cap check, after its probe
    // 402 but BEFORE any signature. Fetch script: probe→402, retry→200, probe→402.
    let sigCount = 0;
    let i = 0;
    const responses: Array<() => Response> = [
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("2000") } }),
      () =>
        new Response(
          JSON.stringify({ url: "u", markdown: "m", tokens: 1, cache_hit: false, usage: {} }),
          { status: 200 },
        ),
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("2000") } }),
    ];
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) sigCount++;
      return responses[Math.min(i++, responses.length - 1)]();
    }) as unknown as typeof fetch;
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: fetchImpl,
      maxSessionSpendUsd: 0.003,
    });

    const first = await client.read("https://ex.com");
    expect(first.markdown).toBe("m");
    await expect(client.read("https://ex.com")).rejects.toBeInstanceOf(SpendCapError);
    expect(sigCount).toBe(1); // only the first read ever signed; the second stopped at the cap
  });

  it("no maxSpendUsd + maxTollUsd: an HONEST quote at exactly base + toll is signed (boundary, no false-reject)", async () => {
    // base $0.002 (2000) + toll $0.02 (20000) = 22000 atomic = $0.022.
    const { client, signed } = walletWith({}, [
      () =>
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("22000") } }),
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
  });
});
