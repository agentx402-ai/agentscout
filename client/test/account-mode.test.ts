import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

// Account-key mode: an opaque `ak_…` bearer is the identity and each fetch debits prepaid credits.
// The request path is a SINGLE bearer-authenticated call — never the wallet-mode probe→402→sign
// dance — so no PAYMENT-SIGNATURE is ever produced (there is no signer to produce one).

const endpoint = "https://scout.example";
const AK = `ak_${"a".repeat(64)}`;

function scripted(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.url, init: init ?? {} });
    return response();
  }) as unknown as typeof fetch;
  return { client: new AgentScout({ accountKey: AK, endpoint, fetch: fetchImpl }), calls };
}

describe("account-key mode request path", () => {
  it("a 200 read carries Authorization: Bearer ak_… and NO PAYMENT-SIGNATURE", async () => {
    const { client, calls } = scripted(
      () =>
        new Response(
          JSON.stringify({
            url: "https://ex.com",
            markdown: "# Hi",
            tokens: 2,
            cache_hit: false,
            usage: {
              service: "scout",
              op: "read",
              price_usd: 0,
              list_price_usd: 0.002,
              credits_charged: 3,
            },
          }),
          { status: 200 },
        ),
    );
    const r = await client.read("https://ex.com");
    expect(r.markdown).toBe("# Hi");
    expect(calls.length).toBe(1); // one bearer-authenticated request, no probe/retry dance
    const h = new Headers(calls[0].init.headers);
    expect(h.get("Authorization")).toBe(`Bearer ${AK}`);
    expect(h.get("PAYMENT-SIGNATURE")).toBeNull(); // account mode never signs an x402 challenge
  });

  it("a 402 insufficient_credits throws a typed error with no signing attempt", async () => {
    const { client, calls } = scripted(
      () =>
        new Response(JSON.stringify({ error: "out of credits", code: "insufficient_credits" }), {
          status: 402,
        }),
    );
    await expect(client.read("https://ex.com")).rejects.toMatchObject({
      code: "insufficient_credits",
      status: 402,
    });
    // Exactly one request; it carried the bearer and never a signature (fund out-of-band via AgentKV).
    expect(calls.length).toBe(1);
    expect(new Headers(calls[0].init.headers).get("PAYMENT-SIGNATURE")).toBeNull();
  });
});
