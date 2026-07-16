import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentScout } from "../src/index";

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());
const PAYEE = "0x0000000000000000000000000000000000000001";

function challenge(amount: string, payTo = PAYEE): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo,
          resource: "/v1/scout/read",
          description: "read",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

/** Build an AgentScout whose transport is a scripted array of responses; capture the requests. */
function scripted(opts: Record<string, unknown>, responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init: init ?? {} });
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return { client: new AgentScout({ signer, endpoint, fetch: fetchImpl, ...opts }), calls };
}

afterEach(() => vi.restoreAllMocks());

describe("read", () => {
  it("no-toll: 402 → sign → retry → 200 with usage; PAYMENT-SIGNATURE on retry, same Idempotency-Key", async () => {
    const { client, calls } = scripted({}, [
      () =>
        new Response(JSON.stringify({ error: "payment required", code: "payment_required" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("2000") },
        }),
      () =>
        new Response(
          JSON.stringify({
            url: "https://ex.com",
            markdown: "# Hi",
            title: "Hi",
            tokens: 3,
            cache_hit: false,
            usage: {
              service: "scout",
              op: "read",
              price_usd: 0.002,
              list_price_usd: 0.002,
              credits_charged: 0,
            },
          }),
          { status: 200 },
        ),
    ]);
    const r = await client.read("https://ex.com");
    expect(r.markdown).toBe("# Hi");
    expect(r.tokens).toBe(3);
    expect(r.cache_hit).toBe(false);
    expect((r as { usage?: unknown }).usage).toBeTruthy();
    expect(calls.length).toBe(2);
    const retry = new Headers(calls[1].init.headers);
    expect(retry.get("PAYMENT-SIGNATURE")).toBeTruthy();
    const k0 = new Headers(calls[0].init.headers).get("Idempotency-Key");
    expect(k0).toBe(retry.get("Idempotency-Key"));
  });

  it("sends max_toll_usd as a QUERY param on both probe and retry, never in the body", async () => {
    const { client, calls } = scripted({}, [
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("2100") } }),
      () =>
        new Response(
          JSON.stringify({
            url: "u",
            markdown: "m",
            tokens: 1,
            cache_hit: false,
            toll: { toll_paid_atomic: 100, tx_hash: "0xabc", rail: "x402" },
          }),
          { status: 200 },
        ),
    ]);
    const r = await client.read("https://ex.com", { maxTollUsd: 0.0001 });
    expect((r as { toll?: unknown }).toll).toBeTruthy();
    for (const c of calls) {
      expect(c.url).toContain("max_toll_usd=");
      const body = c.init.body ? String(c.init.body) : "";
      expect(body).not.toContain("max_toll_usd");
    }
  });

  it("maps a thin_content 422 to a typed error", async () => {
    const { client } = scripted({}, [
      () =>
        new Response(JSON.stringify({ error: "no text", code: "thin_content" }), { status: 422 }),
    ]);
    await expect(client.read("https://ex.com")).rejects.toMatchObject({
      code: "thin_content",
      status: 422,
    });
  });
});
