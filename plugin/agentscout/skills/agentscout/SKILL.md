---
name: agentscout
description: Use AgentScout to fetch web pages as clean markdown (read), extract structured JSON against a schema (extract), price a fetch for free (quote), or crawl a site (crawl). Paid per fetch in USDC via x402 — wallet-native by default (your wallet pays, no signup), with an opt-in account-key (ak_ bearer) mode for managed wallets. Use for grounding an agent in live web content without hand-rolling payment. Publisher tolls (max_toll_usd) are wallet-mode only; account-key credits are funded out-of-band via AgentKV.
---

# AgentScout Skill

AgentScout turns the live web into agent-ready input: give it a URL and it returns clean
markdown (`read`), structured JSON validated against your schema (`extract`), a free price
probe (`quote`), or a whole-site crawl (`crawl`). Every paid fetch settles in real USDC on
Base via the x402 protocol — no accounts, no API keys, no hand-rolled `PAYMENT-SIGNATURE`
signing. The service lives at `https://api.agentx402.ai/v1/scout/*`.

You hold **one AgentScout identity**, in one of two shapes (auto-detected by the client):

- **Wallet-as-payer** (the default): a signable EVM wallet pays each fetch inline via x402.
  AgentScout mints and manages a local wallet on first use — fund it and go, no sign-up.
- **Account-key**: for a *managed* wallet that can't sign, an opaque `ak_…` **bearer token**
  identifies the account and debits **prepaid credits**. Credits are funded out-of-band via
  AgentKV (see **Account-key mode & funding** below).

> **Content is NOT encrypted.** Unlike AgentKV — which encrypts values client-side so the
> server is zero-knowledge — AgentScout returns fetched web content in the clear. It is
> public web data by definition; there is no encryption key and nothing zero-knowledge about
> a scout response. Do not treat a scout result as private.

---

## When to use AgentScout

Use AgentScout when you need:

- **Grounding in live web content** — pull a page as clean markdown (`read`) to summarize,
  quote, or reason over, without a headless browser or an HTML parser of your own.
- **Structured extraction** — turn a page into JSON that validates against a JSON Schema you
  supply (`extract`), e.g. a product's price/spec table or an article's title/author/date.
- **Free price discovery** — call `quote` first to learn the exact toll for a URL **before**
  spending anything; `quote` never signs and never spends.
- **Site crawls** — walk a site up to `max_pages` (`crawl`) and get back a manifest of
  results plus artifact links; long crawls resume by `jobId`.

Do NOT use AgentScout for:

- **Secrets or credentials.** Scout fetches *public* web content; it is not a secret store
  (use AgentKV's secret-safe tools for that).
- **Private pages behind auth.** AgentScout fetches as an anonymous client — it cannot log in,
  carry your session cookies, or reach anything gated behind a login wall.
- **Zero-budget contexts.** `read`, `extract`, and `crawl` each cost real USDC; call `quote`
  and check your spend cap before a loop or a bulk run.

---

## Available MCP Tools

The `agentscout` MCP server exposes five tools — one free probe, three paid fetch verbs, and
a free crawl-status check:

| Tool | Description | Cost |
|------|-------------|------|
| `scout_quote` | Free toll-price probe for a URL — returns atomic-USDC prices and a `would_pay` advisory. Never signs, never spends. | **Free** |
| `scout_read` | Fetch a URL and return clean markdown. `fresh` bypasses the ~6h read cache; `max_tokens` truncates the result. | ~$0.002 USDC + publisher toll |
| `scout_extract` | Fetch a URL and extract structured JSON validated against a JSON Schema you pass, with optional natural-language `instructions`. | ~$0.012 USDC + publisher toll |
| `scout_crawl` | Crawl a site up to `max_pages` (REQUIRED, price-determining) and return a results manifest with artifact links. Long crawls return a `jobId`. | ~$0.002 USDC × `max_pages` + tolls |
| `scout_crawl_status` | Check a crawl job's status by `jobId` — returns the manifest when complete, or the in-flight status. | **Free** |

> **Publisher tolls are wallet-mode only.** A page may carry a publisher **toll** on top of
> the base fee — extra USDC the fetch fronts to the site. `max_toll_usd` caps that toll, but
> it only applies in **wallet mode**: an `ak_` (account-key) caller cannot front a toll, so
> setting `max_toll_usd` in account-key mode is refused client-side (`tolls_require_x402`)
> before any request is sent.

---

## Paying & spend caps

Three ceilings bound what a scout session can spend. Set them in the plugin config (run
`/plugin` to edit) or as env vars for the CLI:

- **`maxSpendUsd`** (`AGENTSCOUT_MAX_SPEND_USD`) — refuse any *single* fetch that would cost
  more than this.
- **`maxSessionSpendUsd`** (`AGENTSCOUT_MAX_SESSION_SPEND_USD`) — refuse further fetches once
  cumulative spend across the whole session exceeds this.
- **`maxTollUsd`** (`AGENTSCOUT_MAX_TOLL_USD`) — cap the publisher toll on a paid fetch.
  **Wallet mode only** (see the caveat above).

Caps **refuse** — a paid tool over the ceiling throws a `SpendCapError` rather than silently
capping and spending less. The SDK always signs the server's exact 402 challenge amount, never
a self-computed one, and enforces every cap *before* signing. `scout_quote` is free and never
counts against a cap, so probe first, then spend within budget.

---

## Account-key mode & funding

Account-key mode uses an `ak_…` bearer token instead of a signing wallet and debits **prepaid
credits**. Two things are specific to scout:

- **Scout has no deposit route.** AgentScout does not mint or fund accounts — there is no
  `scout/deposit` endpoint. `ak_` credits are funded **out-of-band via AgentKV**, which shares
  the same account ledger:

  ```bash
  # Fund the ak_ account from ANY signing wallet (via AgentKV's deposit route):
  awal x402 pay https://api.agentx402.ai/v1/account/deposit \
    --headers '{"Authorization":"Bearer ak_..."}'
  ```

  The credits that deposit buys are then spendable by AgentScout under the same `ak_` bearer.

- **Tolls are refused in account-key mode.** A managed account cannot front a publisher toll,
  so setting `max_toll_usd` (`maxTollUsd`) with an `ak_` credential fails fast client-side with
  a `tolls_require_x402` error — before any request is issued. Use wallet mode if you need to
  pay tolls.

---

## Crawl: resumable jobs

A crawl can outlast a single request. If it does not finish within `timeout_ms`, `scout_crawl`
returns a **pending handle** carrying a `jobId` instead of blocking:

1. `scout_crawl { url, max_pages, timeout_ms }` → either a completed manifest or `{ jobId, … }`.
2. Poll `scout_crawl_status { job_id }` (free) until it returns the completed manifest.
3. Fetch individual page artifacts referenced in the manifest via the SDK/CLI
   (`agentscout crawl artifact <jobId> <key>`).

Because `max_pages` is price-determining, the crawl settles its full cost **upfront**
(`max_pages` × per-page price); resuming a job by `jobId` is free.

---

## One-Time Setup

Install the plugin from Claude Code's marketplace — the exact `/plugin marketplace add` and
`/plugin install` commands are in the plugin's `README.md` (`plugin/README.md`). After install,
Claude Code **prompts** for the config and threads it into the MCP server for you.

### 1. Credentials (entered at install, not via shell env)

| Config | Required | Description |
|--------|----------|-------------|
| Wallet private key | No | Optional — leave blank and AgentScout mints + manages a local wallet on first use (then fund it). To bring your own: an EVM private key (hex), the wallet that pays. |
| Account key | No | An `ak_…` bearer token for managed-wallet (credit) mode. Funded out-of-band via AgentKV. Mutually exclusive with a wallet key. |
| AgentScout endpoint | No | The hosted API; defaults to `https://api.agentx402.ai`. |
| Network | No | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia testnet). |
| Max per-operation spend (USD) | No | Refuse any single fetch that would cost more than this; empty = no per-op cap. |
| Max session spend (USD) | No | Refuse fetches once cumulative session spend exceeds this; empty = no cap. |
| Max publisher toll (USD) | No | Cap the toll on a paid fetch. Wallet mode only; rejected in account-key mode. |

Re-run `/plugin` to change these later. Verify the server loaded with `/mcp` (you should see
the `agentscout` server and its five tools).

### 2. Fund the payer

- **Wallet mode:** send USDC to your wallet address on Base — reads/extracts/crawls are then
  paid inline per fetch via x402. Don't have a wallet? Leave the private-key config blank —
  AgentScout mints and manages a local wallet on first use — then fund the address it prints.
- **Account-key mode:** deposit to AgentKV's `/v1/account/deposit` under your `ak_` bearer (see
  **Account-key mode & funding** above) — scout debits those shared credits.
