import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { walletPath } from "../src/keystore";
import { EXIT } from "../src/output";

const sink = () => {};

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "agentscout-no-mint-"));
}

// Regression: a valid COMMAND with a missing or invalid required argument used to mint and
// persist a wallet to disk (clientFromConfig, built during config resolution in cli.ts) BEFORE
// the usage error was ever reported. The observation that matters is whether wallet.json landed
// on disk, not merely the error text — a reintroduced bug here could still print the right error
// while silently minting again.
describe("a usage error never mints a wallet", () => {
  const usageErrorShapes: Array<{ name: string; argv: string[] }> = [
    { name: "read with no url", argv: ["read"] },
    { name: "extract with no url", argv: ["extract"] },
    { name: "extract with no --schema", argv: ["extract", "https://ex.com"] },
    {
      name: "extract with malformed inline JSON --schema",
      argv: ["extract", "https://ex.com", "--schema", "{not json"],
    },
    {
      name: "extract --schema pointing at a missing file",
      argv: ["extract", "https://ex.com", "--schema", "/no/such/file.json"],
    },
    { name: "quote with no url", argv: ["quote"] },
    { name: "crawl with no url", argv: ["crawl"] },
    { name: "crawl with no --max-pages", argv: ["crawl", "https://ex.com"] },
    { name: "crawl status with no jobId", argv: ["crawl", "status"] },
    { name: "crawl artifact with no jobId/key", argv: ["crawl", "artifact"] },
    {
      name: "crawl artifact with a jobId but no key",
      argv: ["crawl", "artifact", "j1"],
    },
  ];

  it.each(usageErrorShapes)("$name -> usage error, no wallet.json written", async ({ argv }) => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(argv, {
        env: { AGENTSCOUT_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(JSON.parse(err.join("")).code).toBe("usage");
      expect(existsSync(walletPath({ AGENTSCOUT_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Already correct before this fix (unknown command is rejected before any parseFlags/config
  // work runs at all) — pinned here too so a future change can't regress it silently.
  it("unknown command -> usage error, no wallet.json written (already correct)", async () => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(["--definitely-not-a-real-flag"], {
        env: { AGENTSCOUT_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTSCOUT_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Also already correct: a flag missing its value is caught by cli.ts's OWN unrestricted
  // parseFlags call (used to extract global config flags: endpoint/network/max-spend-usd/
  // max-toll-usd), which runs before client construction regardless of this fix. Unlike
  // agentrag, agentscout has no per-command flag allowlist — every flag is valid syntax on
  // every command — so there is no "flag valid on another command" usage-error shape here.
  it("read with a flag missing its value (--out) -> usage error, no wallet.json written (already correct)", async () => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(["read", "https://ex.com", "--out"], {
        env: { AGENTSCOUT_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTSCOUT_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Also already correct, same reason: an entirely unrecognized flag.
  it("read with an unknown flag -> usage error, no wallet.json written (already correct)", async () => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(["read", "https://ex.com", "--bogus"], {
        env: { AGENTSCOUT_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTSCOUT_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
