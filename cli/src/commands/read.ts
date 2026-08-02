import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

/** The validated result of parseReadArgs: either the url + raw per-call flags, or a usage-error message. */
export type ReadArgs =
  | { ok: true; url: string; opts: { maxTollUsd?: number; maxTokens?: number; fresh?: boolean } }
  | { ok: false; message: string };

/**
 * Parse and validate `read`'s own arguments — no client, no network. Split out of runRead so
 * cli.ts can run this SAME check before constructing the client: clientFromConfig (config.ts)
 * mints and persists a wallet on first use, so a missing required argument must never get that
 * far.
 */
export function parseReadArgs(args: string[]): ReadArgs {
  const { flags, positionals } = parseFlags(args);
  const url = positionals[0];
  if (!url) return { ok: false, message: "read requires <url>" };
  const f = flags as { maxTollUsd?: number; maxTokens?: number; fresh?: boolean };
  return {
    ok: true,
    url,
    opts: { maxTollUsd: f.maxTollUsd, maxTokens: f.maxTokens, fresh: f.fresh },
  };
}

export async function runRead(
  args: string[],
  io: {
    client: { read: (url: string, o?: Record<string, unknown>) => Promise<unknown> };
    stdout: Writer;
    stderr: Writer;
    defaults?: { maxTollUsd?: number };
  },
): Promise<number> {
  const parsed = parseReadArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  const result = await io.client.read(parsed.url, {
    maxTollUsd: parsed.opts.maxTollUsd ?? io.defaults?.maxTollUsd,
    maxTokens: parsed.opts.maxTokens,
    fresh: parsed.opts.fresh,
  });
  printJson(io.stdout, result);
  return EXIT.OK;
}
