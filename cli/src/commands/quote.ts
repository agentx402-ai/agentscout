import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

export async function runQuote(
  args: string[],
  io: { client: { quote: (url: string) => Promise<unknown> }; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { positionals } = parseFlags(args);
  const url = positionals[0];
  if (!url) {
    printError(io.stderr, "usage", "quote requires <url>");
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.quote(url));
  return EXIT.OK;
}
