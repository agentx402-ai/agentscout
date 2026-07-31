import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentScoutError } from "@agentscout/client";
import { describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINT, readConfigFile, resolveConfig } from "../src/config";

/** An isolated AGENTSCOUT_HOME so these never read (or write) the developer's own config. */
function tmpEnv(): NodeJS.ProcessEnv {
  return { AGENTSCOUT_HOME: mkdtempSync(join(tmpdir(), "agentscout-cfg-")) };
}
const clean = (env: NodeJS.ProcessEnv) =>
  rmSync(env.AGENTSCOUT_HOME as string, { recursive: true, force: true });
const configPath = (env: NodeJS.ProcessEnv) => join(env.AGENTSCOUT_HOME as string, "config.json");

/** Return the thrown value (so its type/code can be asserted), or fail if nothing threw. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw, got none");
}

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
  it("ignores a file-supplied secret even when env is unset (no `?? file.<secret>` fallback)", () => {
    // The prior test only proves env WINS over file. This pins the env-UNSET case: a file-supplied
    // privateKey/accountKey must be ignored entirely — the leak a `?? file.privateKey` regression
    // would introduce, which env-wins precedence would never catch.
    const c = resolveConfig(
      {},
      {},
      () => ({ privateKey: "0xFROMFILE", accountKey: `ak_${"b".repeat(64)}` }) as never,
    );
    expect(c.privateKey).toBeUndefined();
    expect(c.accountKey).toBeUndefined();
  });
  it("fails closed on a malformed numeric env (a typo'd cap must not become unlimited)", () => {
    expect(() => resolveConfig({}, { AGENTSCOUT_MAX_SPEND_USD: "abc" }, () => null)).toThrow(
      /AGENTSCOUT_MAX_SPEND_USD/,
    );
  });
  it("fails closed on a malformed cap from the config FILE too, not just env", () => {
    // Regression: file.maxSpendUsd used to flow through unvalidated (a bare JSON.parse cast), so a
    // typo'd config.json cap ("$0.05", "0,05", …) silently disabled the guard. It must fail closed
    // the same as the env path.
    expect(() => resolveConfig({}, {}, () => ({ maxSpendUsd: "$0.05" }) as never)).toThrow(
      /maxSpendUsd/,
    );
  });

  // Regression: the file cap was validated INSIDE the ?? chain, so a winning flag/env cap
  // short-circuited the check and a malformed persisted value went uninspected — latent until the
  // first run without the override, where it becomes the ACTIVE cap. Validate it either way.
  it("validates the config-FILE cap even when a flag or env cap outranks it", () => {
    expect(() =>
      resolveConfig(
        {},
        { AGENTSCOUT_MAX_SPEND_USD: "0.01" },
        () => ({ maxSpendUsd: "0,05" }) as never,
      ),
    ).toThrow(/maxSpendUsd/);
    expect(() =>
      resolveConfig({ maxSpendUsd: 0.01 }, {}, () => ({ maxSpendUsd: -1 }) as never),
    ).toThrow(/maxSpendUsd/);
  });

  it("reports a bad config-file value as a typed invalid_config error, not a bare Error", () => {
    // The CLI's mapError prints code + message for an AgentScoutError; a bare Error degrades to
    // the generic "error" path, so the user never learns it was their config file.
    const e = thrown(() => resolveConfig({}, {}, () => ({ maxSpendUsd: "0,05" }) as never));
    expect(e).toBeInstanceOf(AgentScoutError);
    expect((e as AgentScoutError).code).toBe("invalid_config");
  });

  // config.json string fields were passed through with no type check at all, so `"endpoint": 8080`
  // reached the client as a number and died later as a raw TypeError.
  it("type-checks config-file strings (endpoint/network), whatever wins the chain", () => {
    expect(() => resolveConfig({}, {}, () => ({ endpoint: 8080 }) as never)).toThrow(/endpoint/);
    expect(() => resolveConfig({}, {}, () => ({ network: "   " }) as never)).toThrow(/network/);
    expect(() =>
      resolveConfig({ endpoint: "https://flag" }, {}, () => ({ endpoint: 8080 }) as never),
    ).toThrow(/endpoint/);
  });
  it("trims a well-formed config-file string", () => {
    expect(resolveConfig({}, {}, () => ({ endpoint: "  https://file  " })).endpoint).toBe(
      "https://file",
    );
  });
});

// readConfigFile must distinguish ABSENT (null) from PRESENT-but-UNUSABLE (throw). Returning null
// for the second is a fail-OPEN on a money control: the persisted cap disappears and the endpoint
// silently reverts to the production default.
describe("readConfigFile — absent vs unusable", () => {
  const PERSISTED = { maxSpendUsd: 0.002, endpoint: "https://staging.internal" };

  it("absent config.json -> null (the documented default)", () => {
    const env = tmpEnv();
    try {
      expect(readConfigFile(env)).toBeNull();
      const c = resolveConfig({}, env, readConfigFile);
      expect(c.endpoint).toBe(DEFAULT_ENDPOINT); // no file, so the default is correct here
    } finally {
      clean(env);
    }
  });

  it("reads a well-formed config.json", () => {
    const env = tmpEnv();
    try {
      writeFileSync(configPath(env), JSON.stringify(PERSISTED));
      const c = resolveConfig({}, env, readConfigFile);
      expect(c.endpoint).toBe(PERSISTED.endpoint);
      expect(c.maxSpendUsd).toBe(PERSISTED.maxSpendUsd);
    } finally {
      clean(env);
    }
  });

  it("a truncated config.json throws — it never reverts to the production endpoint", () => {
    const env = tmpEnv();
    try {
      // Exactly what a non-atomic write + a crash leaves behind.
      writeFileSync(configPath(env), JSON.stringify(PERSISTED).slice(0, 30));
      expect(() => readConfigFile(env)).toThrow(/not valid JSON/);
      expect(() => resolveConfig({}, env, readConfigFile)).toThrow(/not valid JSON/);
    } finally {
      clean(env);
    }
  });

  it("a non-object config.json (array) throws instead of reading as an empty config", () => {
    const env = tmpEnv();
    try {
      writeFileSync(configPath(env), JSON.stringify([PERSISTED]));
      expect(() => readConfigFile(env)).toThrow(/must contain a JSON object/);
    } finally {
      clean(env);
    }
  });

  it.skipIf(process.platform === "win32")(
    "a config.json that exists but can't be read throws (not mistaken for absent)",
    () => {
      const env = tmpEnv();
      try {
        mkdirSync(configPath(env)); // stand-in for EACCES: present, unreadable as a file
        expect(() => readConfigFile(env)).toThrow(/could not be read/);
      } finally {
        clean(env);
      }
    },
  );
});
