import { readFileSync } from "node:fs";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

function loadSchema(spec: string): object {
  const text = spec.trim().startsWith("{") ? spec : readFileSync(spec, "utf8");
  return JSON.parse(text) as object;
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
  const { flags, positionals } = parseFlags(args);
  const url = positionals[0];
  const f = flags as { schema?: string; instructions?: string; maxTollUsd?: number };
  if (!url) {
    printError(io.stderr, "usage", "extract requires <url>");
    return EXIT.USAGE;
  }
  if (!f.schema) {
    printError(io.stderr, "usage", "extract requires --schema <file|json>");
    return EXIT.USAGE;
  }
  let schema: object;
  try {
    schema = loadSchema(f.schema);
  } catch (e) {
    printError(
      io.stderr,
      "usage",
      `invalid --schema: ${e instanceof Error ? e.message : String(e)}`,
    );
    return EXIT.USAGE;
  }
  printJson(
    io.stdout,
    await io.client.extract(url, schema, {
      instructions: f.instructions,
      maxTollUsd: f.maxTollUsd ?? io.defaults?.maxTollUsd,
    }),
  );
  return EXIT.OK;
}
