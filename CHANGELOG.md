# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [SemVer](https://semver.org/).

## [0.3.1] - 2026-07-29

### Changed

- Dependency floors raised to match what installs already resolve: `viem` `^2.55.10`
  (Dependabot) and `@agentx402-ai/core` `^0.1.1` (metadata-only core release: corrected
  npm repository link). No runtime behavior change in this package.

## [0.3.0] — 2026-07-27

### Added

- **Transparent async extraction.** A document too large for a single pass is extracted server-side
  as a job; the SDK now polls it to completion so `await extract(...)` returns the result directly —
  the async hop is invisible to callers. Polling is free and bounded by `maxWaitMs` (default 120s);
  on timeout the error carries the still-running job's status URL.
- **`read({ links })`.** Opt-in structured outbound links (`PageLink[]`) parsed from the page —
  absolute, deduplicated, `http(s)`-only, capped at 200 in document order. Off by default and costs
  nothing extra (links are collected while the HTML is already parsed, never sent to the model).
- **Extraction metadata** on `ExtractResult.extraction`: `input_truncated`, `winning_rung`
  (`8b` / `repair` / `70b` / `json` / `chunked`), plus `chunks` / `merge_conflicts` on the chunked
  path — so callers can judge how an answer was produced.

### Changed

- Documented the source-verification guarantee on `ExtractResult`: token-like array items are
  checked against the fetched page and dropped if absent (a shape + literal-token check, not a
  truth guarantee for prose or numbers).

## [0.2.0] — 2026-07-26

### Changed
- **Service prices raised on all three paid verbs.** `read` $0.003 → **$0.004**, `extract`
  $0.012 → **$0.020**, `crawl` $0.003 → **$0.004** per page. The client pins each of these as its
  `authorizedCeilingUsd`, so a client pinned BELOW the service's price refuses the service's own
  honest `402` and every call throws `SpendCapError`. **Upgrade is required:** 0.1.x cannot read,
  extract or crawl once the new prices are live.
- Prepaid credit rates follow at the unchanged 20% discount: `read` **32 credits** ($0.0032),
  `extract` **160 credits** ($0.0160), `crawl` **32 credits/page** ($0.0032/page).
- `crawl` stays locked to `read`'s per-page price. This is a no-arbitrage constraint, not an
  independent choice — any gap below `read` re-opens buying a cheap read via `crawl(max_pages=1)`.
- Because the per-page price rose, the crawl rebate threshold is now reached at **250 pages**
  (was 334): the rebate triggers on $1.00 billed, not on a page count.
- Plugin skill reference requotes all three verbs.

### Fixed
- **Corrected the crawl rebate description.** 0.1.2's entry below describes the rebate as
  *marginal* — "20% on the portion above $1.00". The shipped behavior is a **threshold** rebate:
  a crawl that bills $1.00 or more is rebated 20% of the **whole** billed amount, which is
  strictly more generous than what was documented. The plugin skill reference carried the same
  error and is corrected here. Only the docs were ever wrong; no billing behavior changed.

## [0.1.2] — 2026-07-25

### Fixed
- **`crawl` now works against the current service price.** The service raised `crawl` from $0.002 to
  $0.003 per page so a 1-page crawl can no longer undercut a `read`. `CRAWL_PAGE_USD` is the client's
  authorized ceiling for a crawl (`maxPages × price + maxTollUsd`), so a client pinned at $0.002
  rejects the service's honest quote and every `crawl()` throws `SpendCapError`. **Upgrade is
  required:** 0.1.1 and earlier cannot crawl once the new price is live. `read` ($0.003) and
  `extract` ($0.012) are unchanged.

### Changed
- A crawl budget above **$1.00** now earns a **20% volume rebate on the portion above $1.00**,
  credited on completion — x402-funded crawls only, since a credit-funded crawl already pays the
  20%-off rate. The rebate is marginal, so a larger budget never costs less than a smaller one.
- Plugin skill reference requotes `scout_crawl` at ~$0.003/page and notes the rebate.

## [0.1.1] — 2026-07-25

### Fixed
- **`read` now works against the current service price.** The service raised `read` from $0.002 to
  $0.003. `READ_BASE_USD` is the client's `authorizedCeilingUsd` for a read — the client refuses any
  `402` quoting above it — so a client pinned at $0.002 rejects the service's honest quote and every
  `read()` throws `SpendCapError`. **Upgrade is required:** 0.1.0 cannot read from the service once
  the new price is live.

### Changed
- `scout_read` cost in the plugin skill reference and the SDK's mock usage fixtures requote $0.003.
  `extract` ($0.012) and `crawl` ($0.002/page) are unchanged.
- Prepaid AgentScout credits are 20% off the per-op price (not the 90%-off "1/10" that applies to
  AgentKV) — each service sets its own prepay discount. Scout credit costs: read 24, extract 96,
  crawl 16/page.

## [0.1.0] — 2026-07-16

### Added
- `@agentscout/client` SDK: `read`, `extract`, `quote`, `crawl` over the AgentScout x402-paid service, wrapping `@agentx402-ai/core`'s caller-side payment helpers. Wallet (x402) and account-key (`ak_`) auth. Client-side spend caps + `expectedPayTo` recipient pinning.
- `@agentscout/cli` (`@agentscout/cli`): `agentscout read|extract|quote|crawl` + the `agentscout mcp` MCP server (5 tools with truthful paid/read-only annotations).
- Claude Code plugin (`plugin/agentscout`).

### Security
- Publisher tolls (`maxTollUsd`) are wallet-mode only; account-key mode fails fast client-side (`tolls_require_x402`). Secrets read from env/keystore only; error paths redact bearers.
