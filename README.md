# AgentScout

Open-source clients for **AgentScout** — an agent-native web read/extract/crawl service paid
per fetch over [x402](https://x402.org). Give it a URL and get back clean **markdown** (`read`),
structured **JSON** validated against your schema (`extract`), a **free** price probe (`quote`),
or a whole-site **crawl** — every paid fetch settling in **USDC** on Base, with no signup and no
API keys.

There are **two ways to pay**, auto-detected by the client:

- **Wallet-as-payer** (the default): a signable EVM wallet pays each fetch inline via x402.
  AgentScout mints and manages a local wallet on first use, so an agent "just works" once that
  wallet is funded.
- **Account-key** (for *managed* wallets that can't sign — e.g. [awal](https://www.npmjs.com/package/awal)):
  an opaque `ak_…` **bearer token** identifies the account and debits **prepaid credits**.
  Credits are funded out-of-band via AgentKV, so any signing wallet can fund the account and
  fetches carry only the bearer.

Scout content is **not** encrypted — it is public web data by definition (unlike AgentKV, which
encrypts values client-side). A scout response is plaintext; do not treat it as private.

This repository holds the **client surface** — the SDK, CLI, MCP server, and Claude plugin. The
AgentScout service (the backend) is operated separately; these clients talk to it over the
public x402 + EIP-712 protocol.

## Packages

| Path | Package | What |
|------|---------|------|
| [`client/`](./client) | `@agentscout/client` | TypeScript SDK — sign + pay + fetch |
| [`cli/`](./cli) | `@agentscout/cli` | the `agentscout` command-line, and `agentscout mcp` (MCP server) |
| [`plugin/`](./plugin) | — | Claude Code plugin (wraps the MCP server) |

## npm scopes

Two npm scopes separate the **platform** from the **service**:

- **`@agentx402-ai/*`** — the **platform scope**: `@agentx402-ai/core`, a shared SDK for auth,
  payment, usage tracking, error handling, and retry logic, consumed by every agentx402 service.
  It lives in its own repo ([agentx402-ai/core](https://github.com/agentx402-ai/core)) and is a
  published dependency of the packages here.
- **`@agentscout/*`** — the **scout service scope**: `@agentscout/client` and `@agentscout/cli`
  (this repo), which depend on `@agentx402-ai/core` for shared plumbing.

Keeping `@agentx402-ai/core` in its own repo lets sibling services (e.g. `@agentkv/client`)
share it without depending on the AgentScout repo.

## Quick start (SDK)

```bash
npm install @agentscout/client
```

```ts
import { AgentScout } from "@agentscout/client";
import { privateKeyToAccount } from "viem/accounts";

const scout = new AgentScout({
  signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  endpoint: "https://api.agentx402.ai",
  maxSpendUsd: 0.05, // optional: refuse any single fetch over $0.05
});

// quote → FREE price probe (never signs, never spends)
const price = await scout.quote("https://example.com");

// read → clean markdown (paid per fetch in USDC via x402)
const { markdown, title } = await scout.read("https://example.com");

// extract → JSON validated against a JSON Schema you supply
const { data } = await scout.extract("https://example.com", {
  type: "object",
  properties: { headline: { type: "string" } },
});

// crawl → walk a site up to max_pages, get a results manifest
const result = await scout.crawl("https://example.com", { maxPages: 10 });
```

## CLI

```bash
npm install -g @agentscout/cli
export AGENTSCOUT_PRIVATE_KEY=0x...           # endpoint defaults to https://api.agentx402.ai
agentscout quote https://example.com          # free price probe
agentscout read https://example.com           # → clean markdown (paid per fetch)
agentscout extract https://example.com --schema ./schema.json
agentscout crawl https://example.com --max-pages 10
```

No wallet? Leave `AGENTSCOUT_PRIVATE_KEY` unset and AgentScout mints and manages a local wallet
on first use (a `0600` keystore under `~/.agentscout`), printing its address — fund that address
with USDC on Base, then retry. Cap spend any time with `AGENTSCOUT_MAX_SPEND_USD` (per fetch) and
`AGENTSCOUT_MAX_SESSION_SPEND_USD` (cumulative); a malformed value fails closed.

### Account-key mode (works with awal / any managed wallet)

For a *managed* wallet that can't sign (e.g. awal), use an account key funded out-of-band via
AgentKV; every fetch then carries only the bearer and debits the account's prepaid credits:

```bash
export AGENTSCOUT_ACCOUNT_KEY=ak_...          # a bearer minted + funded via AgentKV
agentscout read https://example.com           # debits the account's prepaid credits
```

The client auto-selects account-key mode when `AGENTSCOUT_ACCOUNT_KEY` is set (or a stored
account key exists and no `AGENTSCOUT_PRIVATE_KEY` is set); otherwise it uses the wallet.
Publisher tolls (`--max-toll-usd`) are **wallet-mode only** — an `ak_` caller cannot front a
real-USDC toll, so setting one in account-key mode fails fast (`tolls_require_x402`) before any
request is issued.

## MCP server / Claude plugin

`agentscout mcp` exposes the service as MCP tools — `scout_read`, `scout_extract`, and
`scout_crawl` (the three paid fetch verbs), plus the free `scout_quote` (price a fetch before
spending) and `scout_crawl_status` (resume a long crawl by `jobId`) — for Claude Desktop / Code /
Cursor. The paid verbs are annotated as state-changing (never `readOnlyHint`) so a client knows
to prompt a human before spending.

The [`plugin/`](./plugin) directory packages this as an installable **Claude Code plugin**. In
Claude Code:

```text
/plugin marketplace add agentx402-ai/claude-plugins
/plugin install agentscout@agentx402
```

Claude Code then prompts for your wallet private key (stored in your OS keychain) and the
optional AgentScout endpoint (defaults to the hosted service), and auto-starts the MCP server —
verify with `/mcp`. Full steps: [`plugin/README.md`](./plugin/README.md).

## How it works

- **Pay per fetch over x402.** Each paid verb (`read`, `extract`, `crawl`) is priced by the
  server's `402` challenge and settled in USDC on Base via x402 (EIP-3009
  `transferWithAuthorization`). The SDK signs the challenge's **exact quoted amount** — never a
  self-computed sum — pinning the network, the canonical USDC token, and (when you set
  `expectedPayTo`) the recipient before signing. `quote` is free: it prices a URL without ever
  signing or spending.
- **Wallet-as-payer, or account-key credits.** In wallet mode a signable wallet pays each fetch
  inline and is itself the identity. In account-key mode an opaque `ak_…` bearer is the identity
  and fetches debit prepaid credits funded out-of-band via AgentKV — so any signing wallet can
  fund the account, decoupled from the fetches.
- **Publisher tolls.** Some publishers charge a per-fetch **toll** on top of the base price; the
  SDK pays it only up to your `maxTollUsd` ceiling, and only in wallet mode (an `ak_` caller
  cannot front a real-USDC toll, so tolls are refused client-side in account-key mode).
- **Client-side spend caps.** `maxSpendUsd` (per call) and `maxSessionSpendUsd` (cumulative)
  refuse — never silently cap — any op that would exceed them, checked before the challenge is
  signed.
- **No encryption.** Scout returns public web content in the clear; there is no encryption key
  and nothing zero-knowledge about a response (unlike AgentKV).

## License

[MIT](./LICENSE)
