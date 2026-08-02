import { writeFileSync } from "node:fs";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

type CrawlClient = {
  // Call signature matches the SDK's `crawl(url, CrawlOptions)`: `maxPages` is REQUIRED (it
  // determines the x402 price). A looser `Record<string, unknown>` param would not accept the
  // real `AgentScout.crawl` under strictFunctionTypes (contravariant param check).
  crawl: ((
    url: string,
    o: { maxPages: number; maxTollUsd?: number; sameOrigin?: boolean },
  ) => Promise<unknown>) & {
    status: (jobId: string) => Promise<unknown>;
    artifact: (jobId: string, key: string) => Promise<Response>;
  };
};

/** The validated result of parseCrawlArgs: one of the three subcommand shapes, or a usage-error message. */
export type CrawlArgs =
  | { ok: true; kind: "status"; jobId: string }
  | { ok: true; kind: "artifact"; jobId: string; key: string; out?: string }
  | {
      ok: true;
      kind: "submit";
      url: string;
      opts: { maxPages: number; maxTollUsd?: number; sameOrigin?: boolean };
    }
  | { ok: false; message: string };

/**
 * Parse and validate `crawl`'s own arguments — no client, no network. See parseReadArgs's doc
 * comment (commands/read.ts) for why this is split out: cli.ts runs it before clientFromConfig,
 * which mints a wallet on first use. `crawl` has THREE shapes (status / artifact / submit), each
 * with its own required positionals — all three must clear before any client exists.
 */
export function parseCrawlArgs(args: string[]): CrawlArgs {
  const sub = args[0];
  if (sub === "status") {
    const jobId = args[1];
    if (!jobId) return { ok: false, message: "crawl status requires <jobId>" };
    return { ok: true, kind: "status", jobId };
  }
  if (sub === "artifact") {
    const { flags, positionals } = parseFlags(args.slice(1));
    const [jobId, key] = positionals;
    if (!jobId || !key) return { ok: false, message: "crawl artifact requires <jobId> <key>" };
    return {
      ok: true,
      kind: "artifact",
      jobId,
      key,
      out: (flags as { out?: string }).out,
    };
  }
  // default: submit + wait
  const { flags, positionals } = parseFlags(args);
  const url = positionals[0];
  if (!url) return { ok: false, message: "crawl requires <url>" };
  const f = flags as {
    maxPages?: number;
    maxTollUsd?: number;
    sameOrigin?: boolean;
    noSameOrigin?: boolean;
  };
  if (f.maxPages === undefined) {
    return {
      ok: false,
      message: "crawl requires --max-pages <n> (it determines the price)",
    };
  }
  const sameOrigin = f.noSameOrigin ? false : f.sameOrigin ? true : undefined;
  return {
    ok: true,
    kind: "submit",
    url,
    opts: { maxPages: f.maxPages, maxTollUsd: f.maxTollUsd, sameOrigin },
  };
}

export async function runCrawl(
  args: string[],
  io: {
    client: CrawlClient;
    stdout: Writer;
    stderr: Writer;
    defaults?: { maxTollUsd?: number };
  },
): Promise<number> {
  const parsed = parseCrawlArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  if (parsed.kind === "status") {
    printJson(io.stdout, await io.client.crawl.status(parsed.jobId));
    return EXIT.OK;
  }
  if (parsed.kind === "artifact") {
    const res = await io.client.crawl.artifact(parsed.jobId, parsed.key);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (parsed.out) {
      writeFileSync(parsed.out, bytes, { flag: "wx" });
      printJson(io.stdout, {
        found: true,
        path: parsed.out,
        bytes: bytes.length,
      });
    } else io.stdout(bytes.toString("utf8"));
    return EXIT.OK;
  }
  // kind === "submit"
  printJson(
    io.stdout,
    await io.client.crawl(parsed.url, {
      maxPages: parsed.opts.maxPages,
      maxTollUsd: parsed.opts.maxTollUsd ?? io.defaults?.maxTollUsd,
      sameOrigin: parsed.opts.sameOrigin,
    }),
  );
  return EXIT.OK;
}
