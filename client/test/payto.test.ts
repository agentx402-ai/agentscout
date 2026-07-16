import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());
const EXPECTED = "0x0000000000000000000000000000000000000001";
const ATTACKER = "0x0000000000000000000000000000000000000002";

function challenge(payTo: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "2000",
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

function walletWith(payTo: string, expectedPayTo: string) {
  let signed = false;
  const fetchImpl = (async (_u: any, init?: RequestInit) => {
    if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed = true;
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge(payTo) } });
  }) as unknown as typeof fetch;
  return {
    client: new AgentScout({ signer, endpoint, fetch: fetchImpl, expectedPayTo }),
    signed: () => signed,
  };
}

describe("expectedPayTo recipient pin", () => {
  it("rejects a challenge whose payTo differs, NO signature produced", async () => {
    const { client, signed } = walletWith(ATTACKER, EXPECTED);
    await expect(client.read("https://ex.com")).rejects.toMatchObject({ code: "payto_mismatch" });
    expect(signed()).toBe(false);
  });
});
