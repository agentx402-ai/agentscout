import { describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINT, resolveConfig } from "../src/config";

describe("resolveConfig precedence + fail-closed", () => {
  it("defaults endpoint + network when nothing set", () => {
    const c = resolveConfig({}, {}, () => null);
    expect(c.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(c.network).toBe("eip155:8453");
  });
  it("flags > env > file > default for endpoint", () => {
    expect(
      resolveConfig({ endpoint: "https://flag" }, { AGENTSCOUT_ENDPOINT: "https://env" }, () => ({
        endpoint: "https://file",
      })).endpoint,
    ).toBe("https://flag");
    expect(
      resolveConfig({}, { AGENTSCOUT_ENDPOINT: "https://env" }, () => ({
        endpoint: "https://file",
      })).endpoint,
    ).toBe("https://env");
    expect(resolveConfig({}, {}, () => ({ endpoint: "https://file" })).endpoint).toBe(
      "https://file",
    );
  });
  it("reads secrets from env ONLY, never the config file", () => {
    const c = resolveConfig(
      {},
      { AGENTSCOUT_PRIVATE_KEY: "0xabc" },
      () => ({ privateKey: "0xFROMFILE" }) as never,
    );
    expect(c.privateKey).toBe("0xabc");
  });
  it("fails closed on a malformed numeric env (a typo'd cap must not become unlimited)", () => {
    expect(() => resolveConfig({}, { AGENTSCOUT_MAX_SPEND_USD: "abc" }, () => null)).toThrow(
      /AGENTSCOUT_MAX_SPEND_USD/,
    );
  });
});
