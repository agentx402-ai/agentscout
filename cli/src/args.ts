/**
 * A user/argument error (missing flag value, malformed numeric flag). Distinct from a
 * runtime failure so runCli's mapError can return EXIT.USAGE (2), not the generic EXIT (1) —
 * scripts branch on that code.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// Every long flag the CLI accepts, across all commands. An unknown flag is rejected
// (fail-closed) rather than silently swallowed — a typo like `--max-toll-us 5` must not
// slip through as a no-op and leave a toll cap unset on real funds.
const KNOWN_FLAGS = new Set([
  "endpoint",
  "network",
  "max-spend-usd",
  "max-toll-usd",
  "max-tokens",
  "max-pages",
  "schema",
  "instructions",
  "same-origin",
  "no-same-origin",
  "fresh",
  "json",
  "pretty",
  "out",
  "reveal",
]);
const BOOL_FLAGS = new Set(["fresh", "same-origin", "no-same-origin", "json", "pretty", "reveal"]);
const NUM_FLAGS = new Set(["max-spend-usd", "max-toll-usd", "max-tokens", "max-pages"]);

function camel(k: string): string {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseFlags(args: string[]): {
  flags: Record<string, unknown>;
  positionals: string[];
} {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (!KNOWN_FLAGS.has(key)) throw new UsageError(`unknown flag --${key}`);
      const boolish = BOOL_FLAGS.has(key);
      const val = boolish ? true : args[++i];
      // A value-expecting flag MUST get a real value. Missing (`--out` at end), empty
      // (`--out ""`), or flag-like (`--out --pretty`) values would otherwise be silently
      // swallowed. Fail loud instead (caught by runCli's mapError).
      if (!boolish && (val === undefined || val === "" || (val as string).startsWith("--"))) {
        throw new UsageError(`flag --${key} requires a value`);
      }
      if (NUM_FLAGS.has(key)) {
        // Numeric flags MUST be a finite, non-negative number — mirror the env path's
        // fail-CLOSED behavior (config.ts numOrThrow). Otherwise a typo like
        // `--max-toll-usd 0,05` -> NaN is non-nullish, so it wins over a valid env cap AND
        // `usd > NaN` is always false, silently DISABLING the toll cap on real funds.
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          throw new UsageError(
            `flag --${key} must be a non-negative number (got ${JSON.stringify(val)})`,
          );
        }
        flags[camel(key)] = n;
      } else {
        flags[camel(key)] = val;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}
