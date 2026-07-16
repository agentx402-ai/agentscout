// cli/src/secrets.ts
//
// Cross-platform helpers for guarding key material. The read helpers (readEnvSecret /
// readFileSecret) are shared by the MCP tools and the CLI so the guards stay identical on both
// surfaces; scrubSensitiveEnv strips the wallet/account key from the MCP server's own env at
// startup so an agent-controlled child process can never read it back.
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { agentscoutDir } from "./keystore";

// DoS guard shared by the file-secret readers: cap the bytes read as a "secret".
export const MAX_SECRET_BYTES = 1024 * 1024;

// Env vars that hold key material the model must never see. Stripped from the MCP server's own
// env at startup (scrubSensitiveEnv) AND refused as a secret SOURCE, so an agent can't read the
// wallet/account key back into the model context.
const SENSITIVE_ENV = ["AGENTSCOUT_PRIVATE_KEY", "AGENTSCOUT_ACCOUNT_KEY"];
// Defense in depth: any AGENTSCOUT_ env var whose NAME looks like private/funded key material is
// ALSO protected, so a future AGENTSCOUT_*_PRIVATE_KEY / _PAYER_KEY var is covered by default
// without a code change. Scoped to the AGENTSCOUT_ prefix so it never refuses a user's UNRELATED
// third-party secret.
const SENSITIVE_ENV_PATTERN =
  /^AGENTSCOUT_.*(PRIVATE_KEY|PAYER_KEY|ENCRYPTION_KEY|MNEMONIC|SEED_PHRASE)$/i;

/** True if an env var name holds AgentScout's own protected key material (explicit list or pattern). */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV.includes(name) || SENSITIVE_ENV_PATTERN.test(name);
}

/** Delete every protected key var from `env` once the client has captured what it needs. */
export function scrubSensitiveEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) {
    if (isSensitiveEnvName(k)) delete env[k];
  }
}

export type SecretRead = { ok: true; value: string } | { ok: false; error: string; code: string };

/** Read a secret from a local env var. Refuses protected key material and unset/empty. */
export function readEnvSecret(envVar: string): SecretRead {
  if (isSensitiveEnvName(envVar)) {
    return {
      ok: false,
      error: `refusing to read protected key material from ${envVar}`,
      code: "forbidden_env",
    };
  }
  const value = process.env[envVar];
  if (value === undefined || value === "") {
    return { ok: false, error: `env var ${envVar} is unset or empty`, code: "env_unset" };
  }
  return { ok: true, value };
}

/** Read a secret from a local file with path + type + size guards. */
export function readFileSecret(path: string, opts: { trim?: boolean } = {}): SecretRead {
  // Pseudo-filesystems expose process state — /proc/self/environ holds the wallet key — and
  // report unreliable sizes. Never source a "secret" from them. Check the LITERAL path FIRST,
  // before ANY filesystem access, so the guarantee holds cross-platform (macOS/Windows have no
  // /proc, so realpathSync would otherwise throw read_failed before we could reject it).
  const isPseudoFs = (p: string): boolean => /^(\/proc|\/sys)(\/|$)/.test(p);
  const pseudoFsRefusal: SecretRead = {
    ok: false,
    error: "refusing to read from a pseudo-filesystem path",
    code: "forbidden_path",
  };
  if (isPseudoFs(path)) return pseudoFsRefusal;
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    return { ok: false, error: "could not read file", code: "read_failed" };
  }
  // Also reject if a symlink RESOLVES into /proc or /sys (realpath defeats the redirect).
  if (isPseudoFs(resolved)) return pseudoFsRefusal;
  // Refuse the AgentScout keystore directory itself: wallet.json / account.json hold the wallet
  // private key + account bearer — the SAME material the MCP server scrubs from its env and
  // readEnvSecret refuses. Compare the realpath'd file against the realpath'd keystore dir.
  const within = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  const keystore = agentscoutDir(process.env);
  let keystoreReal = resolvePath(keystore);
  try {
    keystoreReal = realpathSync(keystore);
  } catch {
    // keystore dir may not exist yet — the resolved (non-real) path check still applies
  }
  if (within(resolved, keystoreReal) || within(resolved, resolvePath(keystore))) {
    return {
      ok: false,
      error: "refusing to read from the AgentScout keystore directory",
      code: "forbidden_path",
    };
  }
  let st: Stats;
  try {
    st = lstatSync(resolved);
  } catch {
    return { ok: false, error: "could not read file", code: "read_failed" };
  }
  // Char devices (/dev/zero), FIFOs, etc. report size 0 and never EOF — readFileSync would read
  // forever and the size guard wouldn't catch it. Regular files only.
  if (!st.isFile()) {
    return { ok: false, error: "not a regular file", code: "not_regular_file" };
  }
  if (st.size > MAX_SECRET_BYTES) {
    return { ok: false, error: "file too large for a secret", code: "file_too_large" };
  }
  let value: string;
  try {
    value = readFileSync(resolved, "utf8");
  } catch {
    return { ok: false, error: "could not read file", code: "read_failed" };
  }
  if (opts.trim !== false) value = value.replace(/\r?\n$/, "");
  return { ok: true, value };
}
