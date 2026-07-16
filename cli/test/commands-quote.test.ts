import { describe, expect, it } from "vitest";
import { runQuote } from "../src/commands/quote";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    quote: async (url: string) => ({ url, priceUsd: 0.01 }),
    ...over,
  } as never;
}
const io = (client: never) => ({
  client,
  stdout: (s: string) => out.push(s),
  stderr: (s: string) => err.push(s),
  env: {} as NodeJS.ProcessEnv,
});
let out: string[] = [];
let err: string[] = [];

describe("quote command", () => {
  it("requires <url> (usage error, exit 2)", async () => {
    out = [];
    err = [];
    const code = await runQuote([], io(fakeClient()));
    expect(code).toBe(2);
    expect(err.join("")).toContain("url");
  });
  it("prints the quote for a url", async () => {
    out = [];
    err = [];
    const code = await runQuote(["https://ex.com"], io(fakeClient()));
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).priceUsd).toBe(0.01);
  });
});
