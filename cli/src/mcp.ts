import type { AgentScout } from "@agentscout/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isAccountMode, resolveWalletIdentity, type WalletIdentity } from "./commands/wallet";
import { clientFromConfig, readConfigFile, resolveConfig } from "./config";
import { scrubSensitiveEnv } from "./secrets";
import { VERSION } from "./version";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

// Structured tool-error envelope for a refusal the MCP layer makes itself. Same {error, code}
// shape the SDK's own errors carry, so a model branches on `code` identically either way.
const toolError = (error: string, code: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: JSON.stringify({ error, code }) }],
});

type TollChoice =
  | { ok: true; maxTollUsd: number | undefined }
  | { ok: false; refusal: ReturnType<typeof toolError> };

/**
 * Decide the per-call publisher toll a paid verb passes to the client.
 *
 * Wallet mode: an explicit `max_toll_usd` wins, else the configured default.
 *
 * Account-key mode: a toll budget is impossible — an `ak_` bearer cannot front real USDC, so
 * `assertTollBudget` throws `tolls_require_x402` before any request is issued. The two ways a toll
 * can arrive are NOT the same request, so they must not get the same answer:
 *   - a configured DEFAULT (AGENTSCOUT_MAX_TOLL_USD, or the plugin's `max_toll_usd`, which the
 *     plugin offers alongside `account_key` and documents as "ignored ... in account-key mode") is
 *     IGNORED. Applying it unconditionally made read/extract/crawl all throw before they dialed the
 *     endpoint — one config field silently bricked the entire paid surface.
 *   - an EXPLICIT `max_toll_usd` is REFUSED, carrying the client's own `tolls_require_x402` code.
 *     Silently dropping a cap the caller asked for on a real-money verb would be the worse bug.
 * A zero budget is not a budget, so it is not refused; it simply becomes "no toll" rather than a
 * `max_toll_usd=0` query param an `ak_` caller has no business sending. The client's own
 * assertTollBudget remains the authoritative guard on every path.
 */
function tollFor(
  accountMode: boolean,
  explicit: number | undefined,
  configuredDefault: number | undefined,
): TollChoice {
  if (!accountMode) return { ok: true, maxTollUsd: explicit ?? configuredDefault };
  if (explicit !== undefined && explicit > 0) {
    return {
      ok: false,
      refusal: toolError(
        "max_toll_usd is wallet-mode only; an ak_ account-key caller cannot front real-USDC " +
          "publisher tolls. Retry without max_toll_usd, or configure a wallet key to pay tolls.",
        "tolls_require_x402",
      ),
    };
  }
  return { ok: true, maxTollUsd: undefined };
}

export function buildMcpServer(
  client: AgentScout,
  accountMode: boolean,
  // Per-call publisher-toll DEFAULT (resolved from AGENTSCOUT_MAX_TOLL_USD / plugin max_toll_usd).
  // A tool's explicit `max_toll_usd` still overrides it; undefined means no default toll cap.
  // Ignored entirely in account-key mode — see tollFor.
  defaultMaxTollUsd: number | undefined,
  // The wallet scout_wallet_address reports. Resolved by the CALLER, because it must be read
  // before scrubSensitiveEnv() strips AGENTSCOUT_PRIVATE_KEY from the env (see startMcp).
  wallet: WalletIdentity,
): McpServer {
  const server = new McpServer({ name: "agentscout", version: VERSION });

  server.tool(
    "scout_quote",
    "Free toll-price probe for a URL (no spend). Returns atomic-USDC prices + would_pay advisory.",
    { url: z.string().url().describe("The URL to price") },
    { title: "Quote", readOnlyHint: true, openWorldHint: true },
    async (a) => text(await client.quote(a.url)),
  );

  server.tool(
    "scout_read",
    "Fetch a URL and return clean markdown. SPENDS real USDC (x402 wallet mode) or credits (account-key mode); honors maxSpendUsd/maxTollUsd. `max_toll_usd` is wallet-mode only (an ak_ caller cannot front tolls). `fresh` forces past the ~6h cache.",
    {
      url: z.string().url().describe("The URL to read"),
      max_toll_usd: z.number().optional().describe("Wallet-mode-only publisher toll cap, USD"),
      max_tokens: z.number().optional().describe("Truncate the returned markdown to ~N tokens"),
      fresh: z.boolean().optional().describe("Bypass the ~6h read cache (full price)"),
    },
    // NOT read-only: a read SPENDS, so a host must be free to prompt a human before it runs.
    // NOT destructive: fetching a URL destroys nothing. destructiveHint DEFAULTS TO TRUE per the
    // MCP spec, so omitting it advertised this fetch as "may perform destructive updates" — an
    // untruthful annotation. idempotentHint stays omitted: its default (false) is already correct,
    // since each call mints a fresh nonce and is billed separately.
    { title: "Read", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (a) => {
      const toll = tollFor(accountMode, a.max_toll_usd, defaultMaxTollUsd);
      if (!toll.ok) return toll.refusal;
      return text(
        await client.read(a.url, {
          maxTollUsd: toll.maxTollUsd,
          maxTokens: a.max_tokens,
          fresh: a.fresh,
        }),
      );
    },
  );

  server.tool(
    "scout_extract",
    "Fetch a URL and extract structured JSON against a JSON Schema. SPENDS real USDC/credits; honors maxSpendUsd/maxTollUsd (wallet-mode-only tolls).",
    {
      url: z.string().url().describe("The URL to extract from"),
      schema: z
        .record(z.unknown())
        .describe("A JSON Schema object the result must validate against"),
      instructions: z.string().optional().describe("Natural-language extraction guidance"),
      max_toll_usd: z.number().optional().describe("Wallet-mode-only publisher toll cap, USD"),
    },
    // Paid, and non-destructive for the same reason as scout_read — see the note there.
    { title: "Extract", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (a) => {
      const toll = tollFor(accountMode, a.max_toll_usd, defaultMaxTollUsd);
      if (!toll.ok) return toll.refusal;
      return text(
        await client.extract(a.url, a.schema, {
          instructions: a.instructions,
          maxTollUsd: toll.maxTollUsd,
        }),
      );
    },
  );

  server.tool(
    "scout_crawl",
    "Crawl a site (up to max_pages) and return a results manifest with artifact links. SPENDS real USDC/credits (max_pages × per-page price, settled upfront); honors maxSpendUsd/maxTollUsd (wallet-mode-only tolls). Long crawls return a jobId to resume with scout_crawl_status.",
    {
      url: z.string().url().describe("The seed URL"),
      max_pages: z
        .number()
        .int()
        .min(1)
        .describe("Max pages to crawl — REQUIRED, price-determining"),
      max_toll_usd: z.number().optional().describe("Wallet-mode-only publisher toll cap, USD"),
      same_origin: z.boolean().optional().describe("Restrict to the seed origin (default true)"),
      timeout_ms: z
        .number()
        .optional()
        .describe("How long to poll before returning a resumable pending handle"),
    },
    // Paid, and non-destructive for the same reason as scout_read — see the note there.
    { title: "Crawl", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (a) => {
      const toll = tollFor(accountMode, a.max_toll_usd, defaultMaxTollUsd);
      if (!toll.ok) return toll.refusal;
      return text(
        await client.crawl(a.url, {
          maxPages: a.max_pages,
          maxTollUsd: toll.maxTollUsd,
          sameOrigin: a.same_origin,
          timeoutMs: a.timeout_ms,
        }),
      );
    },
  );

  server.tool(
    "scout_crawl_status",
    "Check a crawl job's status (free). Returns the manifest when complete, or the in-flight status.",
    { job_id: z.string().describe("The jobId returned by scout_crawl") },
    { title: "Crawl status", readOnlyHint: true, openWorldHint: true },
    async (a) => text(await client.crawl.status(a.job_id)),
  );

  server.tool(
    "scout_wallet_address",
    "Return the address AgentScout pays from, plus the local keystore file backing it. Free and purely local — no network call, no spend. AgentScout mints this wallet on first use, so this is how to find the address to FUND with USDC on Base and the file to back up. Never returns the private key.",
    {},
    // Free, local, and reads nothing but already-resolved local state: read-only, closed-world.
    { title: "Wallet address", readOnlyHint: true, openWorldHint: false },
    // `wallet` is a plain value captured at startup — the private key is never in scope here.
    async () => text(wallet),
  );

  return server;
}

export async function startMcp(deps: {
  env: NodeJS.ProcessEnv;
  stderr: (s: string) => void;
}): Promise<number> {
  const cfg = resolveConfig({}, deps.env, () => readConfigFile(deps.env));
  // Visibility, not a default cap: an MCP server lives for a whole session and every paid verb
  // spends, so without a cumulative bound the total is unbounded no matter what the per-op cap is.
  // Say so once, on stderr (stdout is the JSON-RPC channel), rather than changing spend behavior.
  if (cfg.maxSessionSpendUsd === undefined) {
    deps.stderr(
      "agentscout mcp: no session spend cap configured — this server can spend without a " +
        "cumulative bound. Set AGENTSCOUT_MAX_SESSION_SPEND_USD (and AGENTSCOUT_MAX_SPEND_USD) to bound it.\n",
    );
  }
  const accountMode = isAccountMode(deps.env);
  const client = clientFromConfig(cfg, {
    env: deps.env,
    notify: (m) => deps.stderr(`agentscout: ${m}\n`),
  });
  // Resolve the paying wallet AFTER clientFromConfig (which mints one on first use, so there is an
  // address to report) but BEFORE scrubSensitiveEnv drops AGENTSCOUT_PRIVATE_KEY — once scrubbed,
  // this would fall through to the keystore and report an address the client never pays from.
  const wallet = resolveWalletIdentity(deps.env, accountMode);
  scrubSensitiveEnv(deps.env);
  const server = buildMcpServer(client, accountMode, cfg.maxTollUsd, wallet);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until the MCP session genuinely closes. Authoritative signal: the
  // SDK server's own onclose hook. Belt-and-suspenders: stdin EOF/close as a fallback (an MCP
  // host that closes our stdin without a clean transport close still lets us exit). resolve is
  // idempotent, so both signals firing is harmless.
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
  });
  return 0;
}
