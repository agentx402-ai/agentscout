import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());

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
          resource: "/v1/scout/extract",
          description: "extract",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

function scripted(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.url, init: init ?? {} });
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return { client: new AgentScout({ signer, endpoint, fetch: fetchImpl }), calls };
}

const SCHEMA = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };

describe("extract", () => {
  it("posts url+schema+instructions in the body; 402 → sign → 200 returns data", async () => {
    const { client, calls } = scripted([
      () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge("5000") } }),
      () =>
        new Response(
          JSON.stringify({
            url: "https://ex.com",
            data: { title: "Hi" },
            usage: {
              service: "scout",
              op: "extract",
              price_usd: 0.012,
              list_price_usd: 0.012,
              credits_charged: 0,
            },
          }),
          { status: 200 },
        ),
    ]);
    const r = await client.extract("https://ex.com", SCHEMA, { instructions: "grab the title" });
    expect(r.data).toEqual({ title: "Hi" });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.url).toBe("https://ex.com");
    expect(body.schema).toEqual(SCHEMA);
    expect(body.instructions).toBe("grab the title");
  });

  it("maps extraction_failed (422) and schema_too_large (413) to typed errors", async () => {
    const { client } = scripted([
      () =>
        new Response(JSON.stringify({ error: "no match", code: "extraction_failed" }), {
          status: 422,
        }),
    ]);
    await expect(client.extract("https://ex.com", SCHEMA)).rejects.toMatchObject({
      code: "extraction_failed",
      status: 422,
    });

    const { client: tooLarge } = scripted([
      () =>
        new Response(JSON.stringify({ error: "schema too large", code: "schema_too_large" }), {
          status: 413,
        }),
    ]);
    await expect(tooLarge.extract("https://ex.com", SCHEMA)).rejects.toMatchObject({
      code: "schema_too_large",
      status: 413,
    });
  });
});
