import { describe, expect, it } from "vitest";
import { runRead } from "../src/commands/read";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    read: async (url: string, o?: Record<string, unknown>) => ({ url, ok: true, opts: o }),
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

describe("read command", () => {
  it("requires <url> (usage error, exit 2)", async () => {
    out = [];
    err = [];
    const code = await runRead([], io(fakeClient()));
    expect(code).toBe(2);
    expect(err.join("")).toContain("url");
  });
  it("reads the url and prints the result", async () => {
    out = [];
    err = [];
    const code = await runRead(["https://ex.com"], io(fakeClient()));
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).ok).toBe(true);
  });
  it("passes maxTollUsd/maxTokens/fresh flags through to the client", async () => {
    out = [];
    err = [];
    let seen: Record<string, unknown> | undefined;
    const client = fakeClient({
      read: async (_url: string, o?: Record<string, unknown>) => {
        seen = o;
        return { ok: true };
      },
    });
    const code = await runRead(
      ["https://ex.com", "--max-toll-usd", "0.05", "--max-tokens", "1000", "--fresh"],
      io(client),
    );
    expect(code).toBe(0);
    expect(seen).toEqual({ maxTollUsd: 0.05, maxTokens: 1000, fresh: true });
  });
  it("falls back to io.defaults.maxTollUsd when no --max-toll-usd flag is given", async () => {
    out = [];
    err = [];
    let seen: Record<string, unknown> | undefined;
    const client = fakeClient({
      read: async (_url: string, o?: Record<string, unknown>) => {
        seen = o;
        return { ok: true };
      },
    });
    const code = await runRead(["https://ex.com"], {
      ...io(client),
      defaults: { maxTollUsd: 0.07 },
    });
    expect(code).toBe(0);
    expect(seen?.maxTollUsd).toBe(0.07); // the config/env default is applied
  });
  it("an explicit --max-toll-usd overrides io.defaults.maxTollUsd", async () => {
    out = [];
    err = [];
    let seen: Record<string, unknown> | undefined;
    const client = fakeClient({
      read: async (_url: string, o?: Record<string, unknown>) => {
        seen = o;
        return { ok: true };
      },
    });
    const code = await runRead(["https://ex.com", "--max-toll-usd", "0.01"], {
      ...io(client),
      defaults: { maxTollUsd: 0.07 },
    });
    expect(code).toBe(0);
    expect(seen?.maxTollUsd).toBe(0.01); // explicit flag wins over the default
  });
});
