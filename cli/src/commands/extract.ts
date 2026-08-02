import { readFileSync } from "node:fs";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

function loadSchema(spec: string): object {
  const text = spec.trim().startsWith("{") ? spec : readFileSync(spec, "utf8");
  return JSON.parse(text) as object;
}

/** The validated result of parseExtractArgs: either ready-to-send args, or a usage-error message. */
export type ExtractArgs =
  | {
      ok: true;
      url: string;
      schema: object;
      opts: { instructions?: string; maxTollUsd?: number };
    }
  | { ok: false; message: string };

/**
 * Parse and validate `extract`'s own arguments — no client, no network. See parseReadArgs's doc
 * comment (commands/read.ts) for why this is split out: cli.ts runs it before clientFromConfig,
 * which mints a wallet on first use. `--schema` is loaded and parsed here too (a local file read
 * / JSON.parse, no network) — a bad schema is the same class of usage error as a missing one, and
 * must clear before a client is ever built.
 */
export function parseExtractArgs(args: string[]): ExtractArgs {
  const { flags, positionals } = parseFlags(args);
  const url = positionals[0];
  const f = flags as {
    schema?: string;
    instructions?: string;
    maxTollUsd?: number;
  };
  if (!url) return { ok: false, message: "extract requires <url>" };
  if (!f.schema) return { ok: false, message: "extract requires --schema <file|json>" };
  let schema: object;
  try {
    schema = loadSchema(f.schema);
  } catch (e) {
    return {
      ok: false,
      message: `invalid --schema: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return {
    ok: true,
    url,
    schema,
    opts: { instructions: f.instructions, maxTollUsd: f.maxTollUsd },
  };
}

export async function runExtract(
  args: string[],
  io: {
    client: {
      extract: (url: string, schema: object, o?: Record<string, unknown>) => Promise<unknown>;
    };
    stdout: Writer;
    stderr: Writer;
    defaults?: { maxTollUsd?: number };
  },
): Promise<number> {
  const parsed = parseExtractArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  printJson(
    io.stdout,
    await io.client.extract(parsed.url, parsed.schema, {
      instructions: parsed.opts.instructions,
      maxTollUsd: parsed.opts.maxTollUsd ?? io.defaults?.maxTollUsd,
    }),
  );
  return EXIT.OK;
}
