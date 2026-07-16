import { describe, expect, it } from "vitest";
import { parseFlags, UsageError } from "../src/args";

describe("parseFlags", () => {
  it("collects positionals and camelCases known flags", () => {
    const { flags, positionals } = parseFlags(["read", "https://x", "--max-tokens", "500"]);
    expect(positionals).toEqual(["read", "https://x"]);
    expect(flags.maxTokens).toBe(500); // numeric flag parsed to a number, key camelCased
  });

  it("rejects an unknown flag (fail-closed) with a UsageError", () => {
    expect(() => parseFlags(["--max-spend-us", "5"])).toThrow(UsageError);
    expect(() => parseFlags(["--bogus"])).toThrow(/unknown flag --bogus/);
  });

  it("boolean flags take no value and become true", () => {
    const { flags } = parseFlags(["read", "https://x", "--fresh", "--no-same-origin"]);
    expect(flags.fresh).toBe(true);
    expect(flags.noSameOrigin).toBe(true);
  });

  it("a value-expecting flag missing its value throws", () => {
    expect(() => parseFlags(["--schema"])).toThrow(/flag --schema requires a value/);
    expect(() => parseFlags(["--out", "--json"])).toThrow(/flag --out requires a value/);
  });

  it("numeric flags fail closed on a non-number (a typo'd cap must not disable it)", () => {
    expect(() => parseFlags(["--max-pages", "abc"])).toThrow(/must be a non-negative number/);
    expect(() => parseFlags(["--max-toll-usd", "-1"])).toThrow(/must be a non-negative number/);
  });
});
