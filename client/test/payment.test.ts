import * as core from "@agentx402-ai/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

// A tiny subclass to reach the protected transport in a test.
class Probe extends AgentScout {
  call(url: string, build: () => RequestInit) {
    return (this as unknown as { fetchWithRetry: AgentScout["fetchWithRetry"] }).fetchWithRetry(
      url,
      build,
    );
  }
}

describe("payment shim + transport", () => {
  it("re-exports core's caller-side helpers", () => {
    expect(typeof core.buildPaymentHeader).toBe("function");
    expect(typeof core.challengePriceUsd).toBe("function");
    expect(typeof core.buildBearerHeaders).toBe("function");
  });

  it("fetchWithRetry uses the injected fetch and passes maxRetries through", async () => {
    let seen = 0;
    const fakeFetch = (async (_url: string, _init?: RequestInit) => {
      seen++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const c = new Probe({
      signer: privateKeyToAccount(generatePrivateKey()),
      endpoint: "https://s.example",
      fetch: fakeFetch,
      retries: 0,
    });
    const res = await c.call("https://s.example/v1/scout/ping", () => ({ method: "GET" }));
    expect(res.status).toBe(200);
    expect(seen).toBe(1);
  });
});
