import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

// Opt-in live smoke test against the REAL deployed AgentScout service. Skipped unless
// AGENTSCOUT_LIVE=1 so normal `npm test` / CI stays fully offline and deterministic.
//
// It exercises only `quote`, which is FREE — no auth, no signing, no on-chain settlement, no spend.
// The ephemeral generated signer exists solely to satisfy the constructor's auth requirement and
// never signs anything (quote is an unauthenticated GET). Run it with:
//   AGENTSCOUT_LIVE=1 npm --workspace client test -- live
const LIVE = process.env.AGENTSCOUT_LIVE === "1";
const endpoint = process.env.AGENTSCOUT_ENDPOINT ?? "https://api.agentx402.ai";

describe.skipIf(!LIVE)("live smoke (AGENTSCOUT_LIVE=1)", () => {
  it("quote() against the real service returns a well-formed QuoteResult (free, no spend)", async () => {
    const scout = new AgentScout({
      signer: privateKeyToAccount(generatePrivateKey()),
      endpoint,
    });
    const q = await scout.quote("https://example.com");

    // Shape assertions pinned to the deployed wire contract.
    expect(typeof q.would_pay).toBe("boolean");
    expect(q.advisory).toBe(true);
    expect(typeof q.hint).toBe("string");
    expect(typeof q.ts).toBe("number");
    // rail is "x402" | null.
    expect(q.rail === null || q.rail === "x402").toBe(true);
    // Prices are atomic-USDC integers or null (never USD floats).
    for (const f of [q.toll_price, q.settle_fee, q.total]) {
      expect(f === null || Number.isInteger(f)).toBe(true);
    }
    // payee_sanctioned, when present, is literally true.
    if (q.payee_sanctioned !== undefined) expect(q.payee_sanctioned).toBe(true);
  }, 30_000);
});
