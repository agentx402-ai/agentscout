import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAccountKeyFormat } from "@agentscout/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Frictionless onboarding: with no AGENTSCOUT_PRIVATE_KEY set, the CLI / MCP server mints a
// local wallet on first use and reuses it thereafter — so an agent "just works" with its own
// signable wallet, no setup. The key IS the agent's identity and pays its tolls, so it's
// persisted to a 0600 file inside a 0700 dir (POSIX). The location is ~/.agentscout/wallet.json
// (next to config.json); override the base dir with AGENTSCOUT_HOME.

const POSIX = process.platform !== "win32";
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export interface StoredWallet {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  path: string;
  created: boolean;
}

/** Base directory for AgentScout local state (override with AGENTSCOUT_HOME). */
export function agentscoutDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTSCOUT_HOME?.trim();
  return override ? override : join(homedir(), ".agentscout");
}

export function walletPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentscoutDir(env), "wallet.json");
}

export function accountPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentscoutDir(env), "account.json");
}

/** Create the AgentScout dir as 0700 (POSIX). Best-effort chmod; the 0600 file is the guard. */
function ensureDir(env: NodeJS.ProcessEnv): void {
  const dir = agentscoutDir(env);
  mkdirSync(dir, { recursive: true, mode: POSIX ? 0o700 : undefined });
  if (POSIX) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // dir perms are best-effort; the 0600 file is the primary guard
    }
  }
}

/** Write a JSON keystore file create-exclusive (wx) at mode 0600 (POSIX), defeating umask. */
function writeKeystoreFile(file: string, body: unknown): void {
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (POSIX) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best-effort; wx already created it with mode 0o600 above
    }
  }
}

function readKey(file: string): `0x${string}` | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { privateKey?: unknown };
    return typeof j.privateKey === "string" && KEY_RE.test(j.privateKey)
      ? (j.privateKey as `0x${string}`)
      : null;
  } catch {
    return null;
  }
}

/** The stored wallet's public address + path, or null if none exists. Never creates one. */
export function peekStoredWallet(
  env: NodeJS.ProcessEnv = process.env,
): { address: `0x${string}`; path: string } | null {
  const file = walletPath(env);
  const key = readKey(file);
  return key ? { address: privateKeyToAccount(key).address, path: file } : null;
}

/** Return the agent's local AgentScout wallet, minting + persisting one on the first call. */
export function getOrCreateStoredWallet(env: NodeJS.ProcessEnv = process.env): StoredWallet {
  const file = walletPath(env);
  const existing = readKey(file);
  if (existing) {
    return {
      privateKey: existing,
      address: privateKeyToAccount(existing).address,
      path: file,
      created: false,
    };
  }
  ensureDir(env);
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  try {
    // create-exclusive (wx): a concurrent first-run cannot clobber an already-minted key.
    writeKeystoreFile(file, { address, privateKey });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      const k = readKey(file);
      if (k)
        return {
          privateKey: k,
          address: privateKeyToAccount(k).address,
          path: file,
          created: false,
        };
    }
    throw e;
  }
  return { privateKey, address, path: file, created: true };
}

// ── Account-key mode ──────────────────────────────────────────────────────────
// A managed account (e.g. an externally-funded wallet that cannot sign) authenticates with
// an opaque `ak_…` bearer token (the worker stores only the bearer's hash). Scout stores no
// encryption key — the account key is the only credential. Unlike the wallet, the account is
// NOT auto-provisioned: it must be funded out-of-band, so an account.json is only ever read
// here (peekStoredAccount), never minted on read.

export interface StoredAccount {
  /** The raw `ak_…` bearer token — the account's identity (server hashes it). */
  accountKey: string;
  path: string;
  created: boolean;
}

/**
 * The stored account (bearer) + path. Never creates one.
 *
 * Distinguishes ABSENT from CORRUPT so a namespace switch can never happen silently:
 *   - file ABSENT (ENOENT)        -> returns null (callers fall through to wallet mode)
 *   - file PRESENT but malformed  -> THROWS (bad JSON, or a bad accountKey)
 *
 * A malformed account.json returning null would let `clientFromConfig` silently fall through
 * to WALLET mode — a namespace switch that strands the funded account with NO error. Throwing
 * lets callers surface a clear config error instead of quietly picking a different identity.
 */
export function peekStoredAccount(env: NodeJS.ProcessEnv = process.env): StoredAccount | null {
  const file = accountPath(env);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    // Genuinely absent (file or its parent dir) -> not account mode. Any OTHER read error
    // (e.g. EACCES) surfaces rather than being mistaken for "no account".
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
  let j: { accountKey?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!isAccountKeyFormat(j.accountKey)) {
    throw new Error(
      `${file} has a missing or malformed accountKey (expected ak_<64 lowercase hex>)`,
    );
  }
  return { accountKey: j.accountKey, path: file, created: false };
}
