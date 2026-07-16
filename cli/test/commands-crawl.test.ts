import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCrawl } from "../src/commands/crawl";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    crawl: Object.assign(async () => ({ status: "complete", jobId: "j1", pages_ok: 2 }), {
      submit: async () => ({ jobId: "j1" }),
      status: async () => ({ status: "complete", job_id: "j1" }),
      artifact: async () => new Response("body", { status: 200 }),
      wait: async () => ({ status: "complete", jobId: "j1" }),
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

describe("crawl command", () => {
  it("requires --max-pages (usage error, exit 2)", async () => {
    out = [];
    err = [];
    const code = await runCrawl(["https://ex.com"], io(fakeClient()));
    expect(code).toBe(2);
    expect(err.join("")).toContain("max-pages");
  });
  it("submits with maxPages and prints the outcome", async () => {
    out = [];
    err = [];
    const code = await runCrawl(["https://ex.com", "--max-pages", "3"], io(fakeClient()));
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).status).toBe("complete");
  });
  it("crawl status <jobId> prints status", async () => {
    out = [];
    err = [];
    const code = await runCrawl(["status", "j1"], io(fakeClient()));
    expect(code).toBe(0);
  });

  it("crawl artifact <jobId> <key> streams the body to stdout", async () => {
    out = [];
    err = [];
    const code = await runCrawl(["artifact", "j1", "k"], io(fakeClient()));
    expect(code).toBe(0);
    expect(out.join("")).toBe("body"); // raw bytes, not JSON-wrapped
  });

  it("crawl artifact --out FILE writes the bytes and prints only {found,path,bytes} (no body on stdout)", async () => {
    out = [];
    err = [];
    const dir = mkdtempSync(join(tmpdir(), "agentscout-artifact-"));
    const dest = join(dir, "artifact.bin");
    try {
      const code = await runCrawl(["artifact", "j1", "k", "--out", dest], io(fakeClient()));
      expect(code).toBe(0);
      expect(readFileSync(dest, "utf8")).toBe("body"); // bytes landed on disk
      const printed = JSON.parse(out.join(""));
      expect(printed).toEqual({ found: true, path: dest, bytes: 4 });
      expect(out.join("")).not.toContain("body"); // body is NOT streamed to stdout with --out
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crawl artifact missing jobId/key -> usage error (exit 2)", async () => {
    out = [];
    err = [];
    expect(await runCrawl(["artifact"], io(fakeClient()))).toBe(2);
    expect(await runCrawl(["artifact", "j1"], io(fakeClient()))).toBe(2);
    expect(err.join("")).toContain("crawl artifact requires");
  });
});
