import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

export async function runRead(
  args: string[],
  io: {
    client: { read: (url: string, o?: Record<string, unknown>) => Promise<unknown> };
    stdout: Writer;
    stderr: Writer;
    defaults?: { maxTollUsd?: number };
  },
): Promise<number> {
  const { flags, positionals } = parseFlags(args);
  const url = positionals[0];
  if (!url) {
    printError(io.stderr, "usage", "read requires <url>");
    return EXIT.USAGE;
  }
  const f = flags as { maxTollUsd?: number; maxTokens?: number; fresh?: boolean };
  const result = await io.client.read(url, {
    maxTollUsd: f.maxTollUsd ?? io.defaults?.maxTollUsd,
    maxTokens: f.maxTokens,
    fresh: f.fresh,
  });
  printJson(io.stdout, result);
  return EXIT.OK;
}
