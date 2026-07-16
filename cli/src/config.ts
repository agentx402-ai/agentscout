import { readFileSync } from "node:fs";
import { AgentScout, type AgentScoutOptions, isAccountKeyFormat } from "@agentscout/client";
import { privateKeyToAccount } from "viem/accounts";
import { agentscoutDir, getOrCreateStoredWallet, peekStoredAccount } from "./keystore";

/**
 * Hosted AgentScout service — used when no endpoint is configured. This is a bare host, not a
 * versioned path: every client targets this host's /v1/scout/* routes (see AgentScout.v1()).
 * The endpoint default lives here in the CLI layer only — the SDK's `endpoint` is required.
 */
export const DEFAULT_ENDPOINT = "https://api.agentx402.ai";

export interface ResolvedConfig {
  endpoint: string;
  network: string;
  maxSpendUsd?: number;
  maxSessionSpendUsd?: number;
  maxTollUsd?: number;
  /** Wallet private key from AGENTSCOUT_PRIVATE_KEY (wallet/x402 mode). */
  privateKey?: `0x${string}`;
  /** The raw `ak_…` account bearer from AGENTSCOUT_ACCOUNT_KEY (account-key mode). */
  accountKey?: string;
}

/** Normalize an env var: undefined, empty, or whitespace-only -> undefined (trimmed). */
function envStr(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Parse a non-negative numeric env var. Unset/empty -> undefined (no cap — the documented
 * default). A set-but-malformed or negative value THROWS (fail closed): a typo'd spend/toll cap
 * must not silently become "unlimited" on real funds.
 */
function numOrThrow(v: string | undefined, name: string): number | undefined {
  if (envStr(v) === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number (got ${JSON.stringify(v)})`);
  }
  return n;
}

/**
 * Read the on-disk config file (`<AGENTSCOUT_HOME|~/.agentscout>/config.json`), tolerating
 * absence / bad JSON / permission errors by returning null. Secrets are NEVER read from here.
 */
export function readConfigFile(env: NodeJS.ProcessEnv): Partial<ResolvedConfig> | null {
  try {
    return JSON.parse(readFileSync(`${agentscoutDir(env)}/config.json`, "utf8"));
  } catch {
    return null; // absent / bad-JSON / EACCES -> treat as empty
  }
}

export function resolveConfig(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  readFile: (env: NodeJS.ProcessEnv) => Partial<ResolvedConfig> | null,
): ResolvedConfig {
  const file = readFile(env) ?? {};
  const f = flags as {
    endpoint?: string;
    network?: string;
    maxSpendUsd?: number;
    maxTollUsd?: number;
  };
  return {
    endpoint: f.endpoint ?? envStr(env.AGENTSCOUT_ENDPOINT) ?? file.endpoint ?? DEFAULT_ENDPOINT,
    network: f.network ?? envStr(env.AGENTSCOUT_NETWORK) ?? file.network ?? "eip155:8453",
    maxSpendUsd:
      f.maxSpendUsd ??
      numOrThrow(env.AGENTSCOUT_MAX_SPEND_USD, "AGENTSCOUT_MAX_SPEND_USD") ??
      file.maxSpendUsd,
    maxSessionSpendUsd: numOrThrow(
      env.AGENTSCOUT_MAX_SESSION_SPEND_USD,
      "AGENTSCOUT_MAX_SESSION_SPEND_USD",
    ),
    maxTollUsd: f.maxTollUsd ?? numOrThrow(env.AGENTSCOUT_MAX_TOLL_USD, "AGENTSCOUT_MAX_TOLL_USD"),
    // secrets: env ONLY — never flags, never the config file
    privateKey: envStr(env.AGENTSCOUT_PRIVATE_KEY) as `0x${string}` | undefined,
    accountKey: envStr(env.AGENTSCOUT_ACCOUNT_KEY),
  };
}

/**
 * Build an SDK client. Raw private keys become a viem signer here — only { signer } |
 * { accountKey } reach the SDK. `maxTollUsd` is NOT passed to the constructor (the SDK takes it
 * per-call on a verb); it lives in ResolvedConfig so commands can read a default and forward it.
 */
export function clientFromConfig(
  cfg: ResolvedConfig,
  opts?: { env?: NodeJS.ProcessEnv; notify?: (m: string) => void },
): AgentScout {
  const base = {
    endpoint: cfg.endpoint,
    network: cfg.network,
    maxSpendUsd: cfg.maxSpendUsd,
    maxSessionSpendUsd: cfg.maxSessionSpendUsd,
  };
  // Account-key mode: explicit env wins; else a stored account.json when no private key is set.
  const stored = cfg.privateKey ? null : peekStoredAccount(opts?.env);
  const accountKey = cfg.accountKey ?? (cfg.privateKey ? undefined : stored?.accountKey);
  if (accountKey) {
    if (!isAccountKeyFormat(accountKey)) {
      throw new Error("AGENTSCOUT_ACCOUNT_KEY must be of the form ak_<64 lowercase hex>");
    }
    return new AgentScout({ ...base, accountKey } as AgentScoutOptions);
  }
  // Wallet mode: use the configured private key or mint/reuse a local wallet.
  let privateKey = cfg.privateKey;
  if (!privateKey) {
    const w = getOrCreateStoredWallet(opts?.env);
    privateKey = w.privateKey;
    if (w.created) {
      opts?.notify?.(
        `created a new wallet ${w.address} (saved to ${w.path}). Fund it, then retry.`,
      );
    }
  }
  return new AgentScout({ ...base, signer: privateKeyToAccount(privateKey) } as AgentScoutOptions);
}
