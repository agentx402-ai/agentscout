import type { AgentScout } from "@agentscout/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { clientFromConfig, readConfigFile, resolveConfig } from "./config";
import { peekStoredAccount } from "./keystore";
import { scrubSensitiveEnv } from "./secrets";
import { VERSION } from "./version";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function buildMcpServer(
  client: AgentScout,
  _accountMode: boolean,
  // Per-call publisher-toll DEFAULT (resolved from AGENTSCOUT_MAX_TOLL_USD / plugin max_toll_usd).
  // A tool's explicit `max_toll_usd` still overrides it; undefined means no default toll cap.
  defaultMaxTollUsd?: number,
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
    { title: "Read", readOnlyHint: false, openWorldHint: true },
    async (a) =>
      text(
        await client.read(a.url, {
          maxTollUsd: a.max_toll_usd ?? defaultMaxTollUsd,
          maxTokens: a.max_tokens,
          fresh: a.fresh,
        }),
      ),
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
    { title: "Extract", readOnlyHint: false, openWorldHint: true },
    async (a) =>
      text(
        await client.extract(a.url, a.schema, {
          instructions: a.instructions,
          maxTollUsd: a.max_toll_usd ?? defaultMaxTollUsd,
        }),
      ),
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
    { title: "Crawl", readOnlyHint: false, openWorldHint: true },
    async (a) =>
      text(
        await client.crawl(a.url, {
          maxPages: a.max_pages,
          maxTollUsd: a.max_toll_usd ?? defaultMaxTollUsd,
          sameOrigin: a.same_origin,
          timeoutMs: a.timeout_ms,
        }),
      ),
  );

  server.tool(
    "scout_crawl_status",
    "Check a crawl job's status (free). Returns the manifest when complete, or the in-flight status.",
    { job_id: z.string().describe("The jobId returned by scout_crawl") },
    { title: "Crawl status", readOnlyHint: true, openWorldHint: true },
    async (a) => text(await client.crawl.status(a.job_id)),
  );

  return server;
}

export async function startMcp(deps: {
  env: NodeJS.ProcessEnv;
  stderr: (s: string) => void;
}): Promise<number> {
  const cfg = resolveConfig({}, deps.env, () => readConfigFile(deps.env));
  const accountMode =
    cfg.accountKey != null || (cfg.privateKey == null && peekStoredAccount(deps.env) != null);
  const client = clientFromConfig(cfg, {
    env: deps.env,
    notify: (m) => deps.stderr(`agentscout: ${m}\n`),
  });
  scrubSensitiveEnv(deps.env);
  const server = buildMcpServer(client, accountMode, cfg.maxTollUsd);
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
