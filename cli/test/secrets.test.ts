import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSensitiveEnvName,
  MAX_SECRET_BYTES,
  readFileSecret,
  scrubSensitiveEnv,
} from "../src/secrets";

describe("scrubSensitiveEnv", () => {
  it("deletes only the sensitive AgentScout key vars, leaving unrelated env intact", () => {
    const env: NodeJS.ProcessEnv = {
      AGENTSCOUT_PRIVATE_KEY: "0xdeadbeef",
      AGENTSCOUT_ACCOUNT_KEY: `ak_${"a".repeat(64)}`,
      AGENTSCOUT_ENDPOINT: "https://api.agentx402.ai", // non-secret config — must survive
      UNRELATED: "keep-me",
    };
    scrubSensitiveEnv(env);
    expect(env.AGENTSCOUT_PRIVATE_KEY).toBeUndefined();
    expect(env.AGENTSCOUT_ACCOUNT_KEY).toBeUndefined();
    expect(env.AGENTSCOUT_ENDPOINT).toBe("https://api.agentx402.ai");
    expect(env.UNRELATED).toBe("keep-me");
  });
});

describe("isSensitiveEnvName", () => {
  it("matches the explicit key list", () => {
    expect(isSensitiveEnvName("AGENTSCOUT_PRIVATE_KEY")).toBe(true);
    expect(isSensitiveEnvName("AGENTSCOUT_ACCOUNT_KEY")).toBe(true);
  });
  it("matches the AGENTSCOUT_-scoped key-material pattern (future vars covered by default)", () => {
    expect(isSensitiveEnvName("AGENTSCOUT_PAYER_KEY")).toBe(true);
    expect(isSensitiveEnvName("AGENTSCOUT_WALLET_PRIVATE_KEY")).toBe(true);
    expect(isSensitiveEnvName("AGENTSCOUT_WALLET_MNEMONIC")).toBe(true);
    expect(isSensitiveEnvName("AGENTSCOUT_SEED_PHRASE")).toBe(true);
  });
  it("does NOT match unrelated or non-scoped names", () => {
    expect(isSensitiveEnvName("UNRELATED")).toBe(false);
    expect(isSensitiveEnvName("AGENTSCOUT_ENDPOINT")).toBe(false);
    expect(isSensitiveEnvName("PRIVATE_KEY")).toBe(false); // unscoped third-party secret untouched
  });
});

describe("readFileSecret guards", () => {
  it("refuses a pseudo-filesystem (/proc) path (literal check, cross-platform)", () => {
    const r = readFileSecret("/proc/self/environ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("forbidden_path");
  });

  it("refuses reading from inside the AgentScout keystore dir (wallet/account key material)", () => {
    const home = mkdtempSync(join(tmpdir(), "agentscout-secrets-"));
    const prev = process.env.AGENTSCOUT_HOME;
    process.env.AGENTSCOUT_HOME = home; // readFileSecret resolves the keystore from process.env
    const file = join(home, "wallet.json");
    writeFileSync(file, JSON.stringify({ privateKey: "0xdead" }));
    try {
      const r = readFileSecret(file);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("forbidden_path");
    } finally {
      if (prev === undefined) delete process.env.AGENTSCOUT_HOME;
      else process.env.AGENTSCOUT_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads an ordinary local file (the guards do not over-refuse)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentscout-secret-ok-"));
    const file = join(dir, "token.txt");
    writeFileSync(file, "s3cr3t\n");
    try {
      const r = readFileSecret(file);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe("s3cr3t"); // one trailing newline trimmed by default
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readFileSecret error paths", () => {
  it("refuses a file larger than MAX_SECRET_BYTES", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentscout-secret-big-"));
    const file = join(dir, "big");
    writeFileSync(file, "x".repeat(MAX_SECRET_BYTES + 1));
    try {
      const r = readFileSecret(file);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("file_too_large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-regular file (a directory is not a secret)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentscout-secret-dir-"));
    try {
      const r = readFileSecret(dir);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not_regular_file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports read_failed for a nonexistent path", () => {
    const r = readFileSecret(join(tmpdir(), "agentscout-nope-xyz", "missing"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("read_failed");
  });
});
