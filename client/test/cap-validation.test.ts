import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout, AgentScoutError } from "../src/index";

// Money-safety invariant 1: a malformed spend cap / toll budget fails CLOSED (throws), it never
// silently becomes "unlimited". These guard the SDK boundary itself — the CLI env/flag paths
// already fail closed, but a direct @agentscout/client consumer or the config.json path can hand
// the constructor/verb any value. Before the fix, a non-finite value made `usd > cap` (and the
// authorized-ceiling check) always false, so the client SIGNED an arbitrarily large 402.

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());

// A hostile server quoting $1000 on every 402, tracking whether a signature was ever SENT.
function hostileWallet(opts: Record<string, unknown>) {
  let signed = false;
  const challenge = btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000000000", // $1000.00
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
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed = true;
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
  }) as unknown as typeof fetch;
  return {
    client: new AgentScout({ signer, endpoint, fetch: fetchImpl, ...opts }),
    signed: () => signed,
  };
}

describe("cap/toll finiteness (fail closed)", () => {
  // The headline regression: a non-finite maxTollUsd made authorizedCeilingUsd NaN, so the
  // client signed a $1000 quote. It must throw before any signature instead.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`read({ maxTollUsd: ${bad} }) throws invalid_config, NO signature`, async () => {
      const { client, signed } = hostileWallet({});
      await expect(client.read("https://ex.com", { maxTollUsd: bad })).rejects.toMatchObject({
        code: "invalid_config",
      });
      expect(signed()).toBe(false);
    });
  }

  it("read({ maxTollUsd: -1 }) throws invalid_config (a negative toll is malformed)", async () => {
    const { client, signed } = hostileWallet({});
    await expect(client.read("https://ex.com", { maxTollUsd: -1 })).rejects.toMatchObject({
      code: "invalid_config",
    });
    expect(signed()).toBe(false);
  });

  // A malformed constructor cap must throw at construction, not be stored (which also silently
  // disabled the DEFAULT_MAX_OP_USD backstop, making it strictly less safe than no cap).
  const BAD: Array<[string, unknown]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ['a string ("$0.05" config typo)', "$0.05"],
    ["a negative number", -0.01],
  ];
  for (const [label, value] of BAD) {
    it(`constructing with maxSpendUsd = ${label} throws AgentScoutError(invalid_config)`, () => {
      expect(() => new AgentScout({ signer, endpoint, maxSpendUsd: value as number })).toThrow(
        AgentScoutError,
      );
      expect(() => new AgentScout({ signer, endpoint, maxSpendUsd: value as number })).toThrow(
        /non-negative finite number/,
      );
    });
    it(`constructing with maxSessionSpendUsd = ${label} throws AgentScoutError`, () => {
      expect(
        () => new AgentScout({ signer, endpoint, maxSessionSpendUsd: value as number }),
      ).toThrow(/non-negative finite number/);
    });
  }

  it("valid finite caps (including 0 and undefined) still construct", () => {
    expect(() => new AgentScout({ signer, endpoint })).not.toThrow();
    expect(
      () => new AgentScout({ signer, endpoint, maxSpendUsd: 0, maxSessionSpendUsd: 1.5 }),
    ).not.toThrow();
  });
});
