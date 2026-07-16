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

export async function runCrawl(
  args: string[],
  io: {
    client: CrawlClient;
    stdout: Writer;
    stderr: Writer;
    defaults?: { maxTollUsd?: number };
  },
): Promise<number> {
  const sub = args[0];
  if (sub === "status") {
    const jobId = args[1];
    if (!jobId) {
      printError(io.stderr, "usage", "crawl status requires <jobId>");
      return EXIT.USAGE;
    }
    printJson(io.stdout, await io.client.crawl.status(jobId));
    return EXIT.OK;
  }
  if (sub === "artifact") {
    const { flags, positionals } = parseFlags(args.slice(1));
    const [jobId, key] = positionals;
    if (!jobId || !key) {
      printError(io.stderr, "usage", "crawl artifact requires <jobId> <key>");
      return EXIT.USAGE;
    }
    const res = await io.client.crawl.artifact(jobId, key);
    const bytes = Buffer.from(await res.arrayBuffer());
    const out = (flags as { out?: string }).out;
    if (out) {
      writeFileSync(out, bytes, { flag: "wx" });
      printJson(io.stdout, { found: true, path: out, bytes: bytes.length });
    } else io.stdout(bytes.toString("utf8"));
    return EXIT.OK;
  }
  // default: submit + wait
  const { flags, positionals } = parseFlags(args);
  const url = positionals[0];
  if (!url) {
    printError(io.stderr, "usage", "crawl requires <url>");
    return EXIT.USAGE;
  }
  const f = flags as {
    maxPages?: number;
    maxTollUsd?: number;
    sameOrigin?: boolean;
    noSameOrigin?: boolean;
  };
  if (f.maxPages === undefined) {
    printError(io.stderr, "usage", "crawl requires --max-pages <n> (it determines the price)");
    return EXIT.USAGE;
  }
  const sameOrigin = f.noSameOrigin ? false : f.sameOrigin ? true : undefined;
  printJson(
    io.stdout,
    await io.client.crawl(url, {
      maxPages: f.maxPages,
      maxTollUsd: f.maxTollUsd ?? io.defaults?.maxTollUsd,
      sameOrigin,
    }),
  );
  return EXIT.OK;
}
