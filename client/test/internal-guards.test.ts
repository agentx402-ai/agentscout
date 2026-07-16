import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout, SpendCapError } from "../src/index";

// These exercise defense-in-depth internals that the public verbs cannot currently reach:
// the DEFAULT_MAX_OP_USD backstop (only fires when an op declares NO authorized ceiling — every
// shipped verb declares one) and the requireSigner guard (wallet paths always have a signer).
// Covering them pins the safety net so a future op that forgets a ceiling still can't overspend.

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
          resource: "/v1/scout/x",
          description: "x",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

class Probe extends AgentScout {
  // Drive performOp with NO authorizedCeilingUsd → exercises the DEFAULT_MAX_OP_USD backstop branch.
  callPerformOpNoCeiling(url: string) {
    return (this as unknown as { performOp: AgentScout["performOp"] }).performOp<unknown>({
      method: "GET",
      path: "/x",
      url,
      idempotencyKey: "k",
      label: "x failed",
      buildRequest: (headers) => ({ method: "GET", headers }),
      parseSuccess: async (r) => JSON.parse(await r.text()),
    });
  }
  callRequireSigner() {
    return (this as unknown as { requireSigner: () => unknown }).requireSigner();
  }
}

describe("internal money-safety guards (defense-in-depth)", () => {
  it("DEFAULT_MAX_OP_USD backstop: an op with no authorized ceiling + no maxSpendUsd refuses a quote over $0.05", async () => {
    let signed = false;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed = true;
      // $0.10 quote, above the built-in $0.05 op ceiling.
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge("100000") },
      });
    }) as unknown as typeof fetch;
    const c = new Probe({ signer, endpoint, fetch: fetchImpl });
    await expect(c.callPerformOpNoCeiling(`${endpoint}/v1/scout/x`)).rejects.toBeInstanceOf(
      SpendCapError,
    );
    expect(signed).toBe(false);
  });

  it("requireSigner throws invalid_config in account-key mode (no wallet signer present)", () => {
    const c = new Probe({ accountKey: AK, endpoint });
    expect(() => c.callRequireSigner()).toThrow(/wallet signer is required/);
  });
});
