import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("help and the unknown-command hint both list `wallet`", async () => {
    const out: string[] = [];
    await runCli(["--help"], { stdout: (s) => out.push(s), stderr: sink });
    expect(out.join("")).toContain("wallet show");
    const err: string[] = [];
    await runCli(["frobnicate"], { stdout: sink, stderr: (s) => err.push(s) });
    expect(JSON.parse(err.join("")).hint).toContain("wallet");
  });
});

describe("runCli dispatches every command inside one error handler", () => {
  // Regression: `mcp` and `wallet` were dispatched ABOVE the try/catch, so a throw from
  // resolveConfig/readConfigFile/peekStoredAccount escaped runCli — on the mcp path as an
  // unhandled rejection with a raw stack trace, because nothing .catch()es that promise.
  // Fail-closed either way (no server starts), but the operator saw a stack, not the reason.
  const CORRUPT = '{ "endpoint": ';

  it("a corrupt config.json on the `mcp` path is a typed error, not an unhandled rejection", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentscout-mcp-cfg-"));
    const out: string[] = [];
    const err: string[] = [];
    try {
      writeFileSync(join(home, "config.json"), CORRUPT);
      // Pre-fix this REJECTED rather than resolving, so awaiting it threw out of the test.
      const code = await runCli(["mcp"], {
        env: { AGENTSCOUT_HOME: home },
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.GENERIC);
      expect(JSON.parse(err.join("")).code).toBe("invalid_config");
      expect(err.join("")).toContain("config.json");
      // stdout is the MCP JSON-RPC channel: diagnostics must never land there.
      expect(out.join("")).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the same corrupt config.json is a typed error on a verb path too", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentscout-verb-cfg-"));
    const err: string[] = [];
    try {
      writeFileSync(join(home, "config.json"), CORRUPT);
      const code = await runCli(["quote", "https://ex.com"], {
        env: { AGENTSCOUT_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.GENERIC);
      expect(JSON.parse(err.join("")).code).toBe("invalid_config");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runCli wallet dispatch", () => {
  it("`wallet show` reports the wallet WITHOUT minting one", async () => {
    // Dispatched before clientFromConfig, which mints a wallet on first use — so the command that
    // answers "do I have a wallet yet?" must not be the thing that creates it.
    const home = mkdtempSync(join(tmpdir(), "agentscout-wallet-cli-"));
    const out: string[] = [];
    try {
      const code = await runCli(["wallet", "show"], {
        env: { AGENTSCOUT_HOME: home },
        stdout: (s) => out.push(s),
        stderr: sink,
      });
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(out.join("")).address).toBeNull();
      expect(existsSync(join(home, "wallet.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a malformed spend cap does not block `wallet show` (no config resolution on this path)", async () => {
    // Discovering the wallet must stay possible while the config is broken — otherwise a bad cap
    // hides the address you need to fund.
    const home = mkdtempSync(join(tmpdir(), "agentscout-wallet-cfg-"));
    const out: string[] = [];
    try {
      const code = await runCli(["wallet", "show"], {
        env: { AGENTSCOUT_HOME: home, AGENTSCOUT_MAX_SPEND_USD: "not-a-number" },
        stdout: (s) => out.push(s),
        stderr: sink,
      });
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(out.join("")).source).toBe("none");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("maps a wallet error through mapError (malformed AGENTSCOUT_PRIVATE_KEY -> invalid_config)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentscout-wallet-bad-"));
    const err: string[] = [];
    try {
      const code = await runCli(["wallet", "show"], {
        env: { AGENTSCOUT_HOME: home, AGENTSCOUT_PRIVATE_KEY: "0xnope" },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.GENERIC);
      expect(JSON.parse(err.join("")).code).toBe("invalid_config");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a corrupt keystore file surfaces as an error, never as a wallet address", async () => {
    // A corrupt account.json must not be reported as "wallet mode with address X" — that is a
    // silent namespace switch. The keystore's throw travels all the way out to a non-zero exit.
    const home = mkdtempSync(join(tmpdir(), "agentscout-wallet-corrupt-"));
    const out: string[] = [];
    const err: string[] = [];
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "account.json"), "{ not json");
      const code = await runCli(["wallet", "show"], {
        env: { AGENTSCOUT_HOME: home },
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.GENERIC);
      expect(err.join("")).toContain("account.json");
      expect(out.join("")).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
