import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AgentScout, AgentScoutError, AgentXError, SpendCapError } from "@agentscout/client";
import { parseFlags, UsageError } from "./args";
import { runCrawl } from "./commands/crawl";
import { runExtract } from "./commands/extract";
import { runQuote } from "./commands/quote";
import { runRead } from "./commands/read";
import { clientFromConfig, readConfigFile, resolveConfig } from "./config";
import { EXIT, printError, type Writer } from "./output";
import { VERSION } from "./version";

const HELP = `agentscout — x402-paid web read/extract/crawl

Usage:
  agentscout read <url> [--max-toll-usd N] [--max-tokens N] [--fresh]
  agentscout extract <url> --schema <file|json> [--instructions TEXT] [--max-toll-usd N]
  agentscout quote <url>
  agentscout crawl <url> --max-pages N [--max-toll-usd N] [--same-origin|--no-same-origin]
  agentscout crawl status <jobId>
  agentscout crawl artifact <jobId> <key> [--out FILE]
  agentscout mcp
  agentscout --version

Secrets come from env only: AGENTSCOUT_PRIVATE_KEY | AGENTSCOUT_ACCOUNT_KEY.
`;

export async function runCli(
  argv: string[],
  deps: { client?: AgentScout; stdout: Writer; stderr: Writer; env?: NodeJS.ProcessEnv },
): Promise<number> {
  const env = deps.env ?? process.env;
  const { stdout, stderr } = deps;
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    stdout(HELP);
    return EXIT.OK;
  }
  if (cmd === "-V" || cmd === "--version" || cmd === "version") {
    stdout(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (cmd === "mcp") {
    const { startMcp } = await import("./mcp.js");
    return startMcp({ env, stderr });
  }

  const KNOWN = new Set(["read", "extract", "quote", "crawl"]);
  if (!KNOWN.has(cmd)) {
    printError(
      stderr,
      "usage",
      `unknown command: ${cmd}`,
      "commands: read extract quote crawl mcp (run `agentscout --help`)",
    );
    return EXIT.USAGE;
  }

  try {
    const cfg = resolveConfig(parseFlags(rest).flags, env, () => readConfigFile(env));
    const client =
      deps.client ??
      clientFromConfig(cfg, {
        env,
        notify: (m) => stderr(`agentscout: ${m}\n`),
      });
    // A resolved maxTollUsd (--max-toll-usd / AGENTSCOUT_MAX_TOLL_USD) becomes the per-call
    // DEFAULT; an explicit per-command --max-toll-usd still overrides it in the handler.
    const io = { client, stdout, stderr, env, defaults: { maxTollUsd: cfg.maxTollUsd } };
    if (cmd === "read") return await runRead(rest, io);
    if (cmd === "extract") return await runExtract(rest, io);
    if (cmd === "quote") return await runQuote(rest, io);
    return await runCrawl(rest, io);
  } catch (e) {
    return mapError(e, stderr);
  }
}

function mapError(e: unknown, stderr: Writer): number {
  if (e instanceof SpendCapError) {
    printError(stderr, e.code, e.message);
    return EXIT.PAYMENT;
  }
  if (e instanceof AgentScoutError) {
    printError(stderr, e.code, e.message, e.hint);
    if (e.status === 404) return EXIT.NOT_FOUND;
    if (e.status === 402) return EXIT.PAYMENT;
    return EXIT.GENERIC;
  }
  // Bare AgentXError (not an AgentScoutError): core's caller-side x402 pins throw these BEFORE any
  // signature — payto_mismatch / network_mismatch / asset_mismatch carry no HTTP status. A payment
  // pin failure is a payment problem (EXIT.PAYMENT); otherwise fall through to the generic code.
  if (e instanceof AgentXError) {
    printError(stderr, e.code, e.message);
    if (e.status === 404) return EXIT.NOT_FOUND;
    if (e.status === 402) return EXIT.PAYMENT;
    if (e.code === "payto_mismatch" || e.code === "network_mismatch" || e.code === "asset_mismatch")
      return EXIT.PAYMENT;
    return EXIT.GENERIC;
  }
  if (e instanceof UsageError) {
    printError(stderr, "usage", e.message);
    return EXIT.USAGE;
  }
  printError(stderr, "error", e instanceof Error ? e.message : String(e));
  return EXIT.GENERIC;
}

function isMainModule(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  runCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }).then((code) => {
    process.exitCode = code;
  });
}
