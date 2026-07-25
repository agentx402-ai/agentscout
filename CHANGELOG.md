# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [SemVer](https://semver.org/).

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
