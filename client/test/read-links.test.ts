import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

const signer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const endpoint = "https://svc.test";

function capture(bodyOut: { last?: Record<string, unknown> }) {
  return (async (_u: unknown, init?: RequestInit) => {
    if (init?.body) bodyOut.last = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        url: "https://x/",
        markdown: "m",
        tokens: 1,
        cache_hit: false,
        usage: {
          service: "scout",
          op: "read",
          price_usd: 0.004,
          list_price_usd: 0.004,
          credits_charged: 0,
        },
        links: [{ text: "Docs", href: "https://x/docs" }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe("read({ links })", () => {
  it("does NOT send links by default", async () => {
    const seen: { last?: Record<string, unknown> } = {};
    const c = new AgentScout({ signer, endpoint, fetch: capture(seen) });
    await c.read("https://x/");
    expect(seen.last?.links).toBeUndefined();
  });

  it("forwards links:true when requested, and surfaces them typed", async () => {
    // Regression for typed-but-not-wired: the option existed on ReadOptions before the
    // client actually sent it, so a caller asking for links silently got none.
    const seen: { last?: Record<string, unknown> } = {};
    const c = new AgentScout({ signer, endpoint, fetch: capture(seen) });
    const r = await c.read("https://x/", { links: true });
    expect(seen.last?.links).toBe(true);
    expect(r.links).toEqual([{ text: "Docs", href: "https://x/docs" }]);
  });
});
