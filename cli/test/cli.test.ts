import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentScoutError, AgentXError, SpendCapError } from "@agentscout/client";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { EXIT } from "../src/output";
import { VERSION } from "../src/version";

const sink = () => {};

describe("runCli dispatch", () => {
  it("unknown command -> EXIT.USAGE and a usage error on stderr", async () => {
    const err: string[] = [];
    const code = await runCli(["frobnicate"], { stdout: sink, stderr: (s) => err.push(s) });
    expect(code).toBe(EXIT.USAGE);
    expect(JSON.parse(err.join("")).code).toBe("usage");
  });

  it("--version prints VERSION and exits OK", async () => {
    const out: string[] = [];
    const code = await runCli(["--version"], { stdout: (s) => out.push(s), stderr: sink });
    expect(code).toBe(EXIT.OK);
    expect(out.join("")).toBe(`${VERSION}\n`);
  });

  it("no command prints help and exits OK", async () => {
    const out: string[] = [];
    const code = await runCli([], { stdout: (s) => out.push(s), stderr: sink });
    expect(code).toBe(EXIT.OK);
    expect(out.join("")).toContain("agentscout");
  });
});

describe("runCli error -> exit-code mapping (mapError)", () => {
  it("a client throwing SpendCapError -> EXIT.PAYMENT", async () => {
    const client = {
      read: vi.fn(async () => {
        throw new SpendCapError("spend $5 exceeds per-call cap $1");
      }),
    };
    const err: string[] = [];
    const code = await runCli(["read", "https://example.com"], {
      client: client as any,
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.PAYMENT);
    expect(JSON.parse(err.join("")).code).toBe("spend_cap_exceeded");
  });

  it("an AgentScoutError with status 404 -> EXIT.NOT_FOUND", async () => {
    const client = {
      read: vi.fn(async () => {
        throw new AgentScoutError("AgentScout 404: not found", "not_found", 404);
      }),
    };
    const err: string[] = [];
    const code = await runCli(["read", "https://example.com/missing"], {
      client: client as any,
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(err.join("")).code).toBe("not_found");
  });

  it("a status-402 AgentScoutError -> EXIT.PAYMENT", async () => {
    const client = {
      read: vi.fn(async () => {
        throw new AgentScoutError(
          "AgentScout 402: insufficient credits",
          "insufficient_credits",
          402,
        );
      }),
    };
    const code = await runCli(["read", "https://example.com"], {
      client: client as any,
      stdout: sink,
      stderr: sink,
    });
    expect(code).toBe(EXIT.PAYMENT);
  });

  it("a bare AgentXError (payto_mismatch from core's caller-side pin) -> EXIT.PAYMENT", async () => {
    const client = {
      read: vi.fn(async () => {
        throw new AgentXError("challenge payTo != expectedPayTo", "payto_mismatch");
      }),
    };
    const err: string[] = [];
    const code = await runCli(["read", "https://example.com"], {
      client: client as any,
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.PAYMENT);
    expect(JSON.parse(err.join("")).code).toBe("payto_mismatch");
  });
});

describe("runCli threads the maxTollUsd default (AGENTSCOUT_MAX_TOLL_USD)", () => {
  it("becomes the per-call default when no --max-toll-usd flag is given", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = {
      read: vi.fn(async (_url: string, o?: Record<string, unknown>) => {
        seen = o;
        return { ok: true };
      }),
    };
    const home = mkdtempSync(join(tmpdir(), "agentscout-toll-"));
    try {
      const code = await runCli(["read", "https://ex.com"], {
        client: client as any,
        env: { AGENTSCOUT_HOME: home, AGENTSCOUT_MAX_TOLL_USD: "0.05" },
        stdout: sink,
        stderr: sink,
      });
      expect(code).toBe(EXIT.OK);
      expect(seen?.maxTollUsd).toBe(0.05);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is overridden by an explicit --max-toll-usd flag", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = {
      read: vi.fn(async (_url: string, o?: Record<string, unknown>) => {
        seen = o;
        return { ok: true };
      }),
    };
    const home = mkdtempSync(join(tmpdir(), "agentscout-toll2-"));
    try {
      const code = await runCli(["read", "https://ex.com", "--max-toll-usd", "0.01"], {
        client: client as any,
        env: { AGENTSCOUT_HOME: home, AGENTSCOUT_MAX_TOLL_USD: "0.05" },
        stdout: sink,
        stderr: sink,
      });
      expect(code).toBe(EXIT.OK);
      expect(seen?.maxTollUsd).toBe(0.01);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runCli secret safety", () => {
  it("a configured AGENTSCOUT_PRIVATE_KEY never appears in stdout or stderr, even on the error path", async () => {
    const SENTINEL = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const home = mkdtempSync(join(tmpdir(), "agentscout-cli-"));
    const out: string[] = [];
    const err: string[] = [];
    try {
      // Malformed cap -> resolveConfig throws (fail-closed) before any client is built. The key is
      // in env, so this pins that it does not leak even on the synchronous error path.
      const code = await runCli(["read", "https://example.com"], {
        env: {
          AGENTSCOUT_HOME: home,
          AGENTSCOUT_PRIVATE_KEY: SENTINEL,
          AGENTSCOUT_MAX_SPEND_USD: "not-a-number",
        },
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      });
      expect(code).not.toBe(EXIT.OK);
      expect([...out, ...err].join("")).not.toContain(SENTINEL);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
