import { describe, expect, it } from "vitest";
import { runExtract } from "../src/commands/extract";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    extract: async (url: string, schema: object, o?: Record<string, unknown>) => ({
      url,
      schema,
      opts: o,
    }),
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

describe("extract command", () => {
  it("requires <url> (usage error, exit 2)", async () => {
    out = [];
    err = [];
    const code = await runExtract([], io(fakeClient()));
    expect(code).toBe(2);
    expect(err.join("")).toContain("url");
  });
  it("requires --schema (usage error, exit 2)", async () => {
    out = [];
    err = [];
    const code = await runExtract(["https://ex.com"], io(fakeClient()));
    expect(code).toBe(2);
    expect(err.join("")).toContain("schema");
  });
  it("rejects malformed inline JSON schema (usage error, exit 2)", async () => {
    out = [];
    err = [];
    const code = await runExtract(["https://ex.com", "--schema", "{not json"], io(fakeClient()));
    expect(code).toBe(2);
    expect(err.join("")).toContain("invalid --schema");
  });
  it("parses inline JSON schema and prints the result", async () => {
    out = [];
    err = [];
    const code = await runExtract(
      ["https://ex.com", "--schema", '{"title":"string"}'],
      io(fakeClient()),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).schema).toEqual({ title: "string" });
  });
});
