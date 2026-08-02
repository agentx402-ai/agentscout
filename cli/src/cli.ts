import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AgentScout, AgentScoutError, AgentXError, SpendCapError } from "@agentscout/client";
import { parseFlags, UsageError } from "./args";
import { parseCrawlArgs, runCrawl } from "./commands/crawl";
import { parseExtractArgs, runExtract } from "./commands/extract";
import { parseQuoteArgs, runQuote } from "./commands/quote";
import { parseReadArgs, runRead } from "./commands/read";
import { runWallet } from "./commands/wallet";
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
  agentscout wallet show
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
  const KNOWN = new Set(["read", "extract", "quote", "crawl"]);
  if (cmd !== "mcp" && cmd !== "wallet" && !KNOWN.has(cmd)) {
    printError(
      stderr,
      "usage",
      `unknown command: ${cmd}`,
      "commands: read extract quote crawl wallet mcp (run `agentscout --help`)",
    );
    return EXIT.USAGE;
  }

  // EVERY command dispatches inside this one try/catch, so a config/keystore failure always reaches
  // the operator as the same typed `{error, code}` line on stderr. `mcp` and `wallet` used to be
  // dispatched above it: their throws (resolveConfig and readConfigFile on a corrupt config.json,
  // peekStoredAccount on a corrupt account.json, clientFromConfig on a bad key) escaped runCli
  // instead — as an unhandled rejection with a raw stack trace on the mcp path, since nothing
  // .catch()es the promise. Fail-closed either way (no server starts, nothing spends), but the
  // operator got a stack trace instead of the reason.
  try {
    if (cmd === "mcp") {
      const { startMcp } = await import("./mcp.js");
      // `await`, not a bare return: returning the promise would hand the rejection back to the
      // caller UNCAUGHT, which is precisely the bug this try/catch exists to close.
      return await startMcp({ env, stderr });
    }
    if (cmd === "wallet") {
      // Dispatched BEFORE the shared client construction below: clientFromConfig MINTS a wallet
      // when none exists, and `wallet show` must report "no wallet yet" without creating one.
      return runWallet(rest, { stdout, stderr, env });
    }
    const cfg = resolveConfig(parseFlags(rest).flags, env, () => readConfigFile(env));
    // Validate the command's OWN required arguments (positionals, and any purely-local check
    // like extract's --schema JSON parse) BEFORE the client construction below —
    // clientFromConfig mints and persists a wallet on first use (config.ts), so a usage error
    // must never get that far. Each parseXxxArgs is the exact check runXxx itself runs (and
    // calls again) — see parseReadArgs's doc comment — so there is one source of truth for
    // what counts as valid. A parseFlags-level throw (unknown flag, missing/malformed value)
    // already propagated from the parseFlags(rest) call directly above, before this ever runs.
    if (cmd === "read") {
      const parsed = parseReadArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    } else if (cmd === "extract") {
      const parsed = parseExtractArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    } else if (cmd === "quote") {
      const parsed = parseQuoteArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    } else {
      const parsed = parseCrawlArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    }
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

/** Print a usage error in the same shape mapError gives UsageError, and return EXIT.USAGE. */
function usageFail(stderr: Writer, message: string): number {
  printError(stderr, "usage", message);
  return EXIT.USAGE;
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
