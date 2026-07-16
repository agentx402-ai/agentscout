import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());

function one(resp: () => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: any) => {
    calls.push(typeof input === "string" ? input : input.url);
    return resp();
  }) as unknown as typeof fetch;
  return { client: new AgentScout({ signer, endpoint, fetch: fetchImpl }), calls };
}

describe("quote", () => {
  it("GETs ?url= and returns the priced branch (atomic integers, rail x402)", async () => {
    const { client, calls } = one(
      () =>
        new Response(
          JSON.stringify({
            toll_price: 10000,
            settle_fee: 500,
            total: 10500,
            rail: "x402",
            would_pay: false,
            advisory: true,
            hint: "priced",
            ts: 1,
          }),
          { status: 200 },
        ),
    );
    const q = await client.quote("https://ex.com");
    expect(q.toll_price).toBe(10000);
    expect(q.rail).toBe("x402");
    expect(calls[0]).toContain("/v1/scout/quote?url=");
  });

  it("parses the sanctioned branch (nulls + payee_sanctioned)", async () => {
    const { client } = one(
      () =>
        new Response(
          JSON.stringify({
            toll_price: null,
            settle_fee: null,
            total: null,
            rail: null,
            would_pay: false,
            advisory: true,
            payee_sanctioned: true,
            hint: "sanctioned",
            ts: 2,
          }),
          { status: 200 },
        ),
    );
    const q = await client.quote("https://ex.com");
    expect(q.rail).toBeNull();
    expect(q.payee_sanctioned).toBe(true);
  });

  it("surfaces rate_limited (429) as a typed error, never pays", async () => {
    const { client } = one(
      () =>
        new Response(JSON.stringify({ error: "slow down", code: "rate_limited" }), { status: 429 }),
    );
    await expect(client.quote("https://ex.com")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });
});
