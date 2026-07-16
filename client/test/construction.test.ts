import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());
const AK = `ak_${"a".repeat(64)}`;

describe("AgentScout construction", () => {
  it("wallet mode: { signer } resolves, defaults applied", () => {
    const c = new AgentScout({ signer, endpoint });
    expect(c.endpoint).toBe(endpoint);
    expect(c.network).toBe("eip155:8453");
    expect(c.maxRetries).toBe(2);
    expect(c.signer).toBe(signer);
    expect(c.accountKey).toBeUndefined();
  });

  it("account mode: { accountKey } resolves", () => {
    const c = new AgentScout({ accountKey: AK, endpoint });
    expect(c.accountKey).toBe(AK);
    expect(c.signer).toBeUndefined();
  });

  it("trims trailing slashes from endpoint", () => {
    expect(new AgentScout({ signer, endpoint: `${endpoint}///` }).endpoint).toBe(endpoint);
  });

  it("requires exactly one auth shape", () => {
    // @ts-expect-error no auth
    expect(() => new AgentScout({ endpoint })).toThrow(
      /provide one of \{ signer \} \| \{ accountKey \}/,
    );
    expect(() => new AgentScout({ signer, accountKey: AK, endpoint })).toThrow(/exactly one/i);
  });

  it("rejects a malformed accountKey", () => {
    expect(() => new AgentScout({ accountKey: "nope", endpoint })).toThrow(/ak_/);
  });

  it("validates expectedPayTo as a checksummable address", () => {
    expect(() => new AgentScout({ signer, endpoint, expectedPayTo: "not-an-address" })).toThrow(
      /expectedPayTo/,
    );
    const good = new AgentScout({ signer, endpoint, expectedPayTo: signer.address });
    expect(good.expectedPayTo).toBe(signer.address);
  });

  it("clamps retries to a non-negative integer, default 2", () => {
    expect(new AgentScout({ signer, endpoint, retries: 0 }).maxRetries).toBe(0);
    expect(new AgentScout({ signer, endpoint, retries: 5 }).maxRetries).toBe(5);
  });
});
