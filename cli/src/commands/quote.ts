import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

/** The validated result of parseQuoteArgs: either the url, or a usage-error message. */
export type QuoteArgs = { ok: true; url: string } | { ok: false; message: string };

/**
 * Parse and validate `quote`'s own arguments — no client, no network. See parseReadArgs's doc
 * comment (commands/read.ts) for why this is split out: cli.ts runs it before clientFromConfig,
 * which mints a wallet on first use.
 */
export function parseQuoteArgs(args: string[]): QuoteArgs {
  const { positionals } = parseFlags(args);
  const url = positionals[0];
  if (!url) return { ok: false, message: "quote requires <url>" };
  return { ok: true, url };
}

export async function runQuote(
  args: string[],
  io: { client: { quote: (url: string) => Promise<unknown> }; stdout: Writer; stderr: Writer },
): Promise<number> {
  const parsed = parseQuoteArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.quote(parsed.url));
  return EXIT.OK;
}
