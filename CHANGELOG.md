# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [SemVer](https://semver.org/).

## [0.5.1] — 2026-08-05

### Fixed

- **A usage error no longer mints a wallet.** A valid command with a missing or invalid required
  argument created and persisted `~/.agentscout/wallet.json` *before* reporting the error, so
  `agentscout read` with no URL answered a typo with `created a new wallet 0x… Fund it, then retry`
  — pointing you at spending money to fix a missing argument, and leaving a private key on disk as
  a side effect of a mistake. Affected `read`, `extract` (missing/invalid `--schema`), `quote`,
  `crawl` (missing `--url`/`--max-pages`), `crawl status`, and `crawl artifact`. Each command now
  validates its own arguments before anything can touch the keystore.

  No wallet is lost by upgrading: the mint was reused on later runs, so this only stops the
  *unwanted* one. The deliberate first-run mint on a genuinely valid command is unchanged.

### Service-side changes since 0.5.0

> These shipped to the hosted service independently of this client release and apply no matter
> which client version you run. Recorded here because this changelog is where they are visible.

- **Plain-text pages are now read correctly, and are billable.** `text/plain`, `text/markdown`,
  `text/csv` and similar bodies were being run through an HTML extractor that yielded zero
  characters, so every `.txt` / `.md` / RFC / source-file page failed the read-success predicate. A
  body the server explicitly declares as non-HTML text is now used as-is.

  **This changes crawl billing.** A crawl only bills pages that meet the read predicate — a failed
  page is non-billable and refunded — so a plain-text page that previously failed and was refunded
  now succeeds and bills at the per-page rate. Crawling a site containing `.txt` files will cost
  more than it did before, and will return the content you are paying for. A server mislabelling
  real HTML as `text/plain` is still detected and extracted as HTML.

## [0.5.0] — 2026-07-31

### Changed

> **Three of these can break a setup that previously appeared to work.** Each replaces a silent
> degradation with a hard, typed failure, so a configuration that was quietly being ignored now
> reports itself instead of running on defaults you did not choose. All three are `invalid_config`.

- **A corrupt or unreadable `config.json` now throws instead of being treated as absent.** Bad
  JSON, a non-object payload, and permission errors previously all returned "no config", so a
  truncated file — what a non-atomic write plus a crash produces — silently dropped a persisted
  spend cap **and** reverted the endpoint to the hosted default. Genuine absence still means "no
  config". *If you upgrade and start seeing this, the file was already being ignored: fix or
  remove it.*
- **`endpoint` must be an absolute `http(s)` URL, validated at construction.** Any truthy value
  was accepted before, so a bare host or a non-`http(s)` scheme only surfaced later as an opaque
  `Invalid URL` — possibly from a paying request — and a non-string from `config.json` died with a
  raw `TypeError`. The endpoint decides which host issues the `402` a wallet signs against, so it
  is now pinned at construction like `expectedPayTo`.
- **A corrupt `wallet.json` now throws instead of reading as "no wallet".** A truncated file
  holding a *funded* key looked absent, after which every operation failed on a raw `EEXIST` from
  the attempt to mint a replacement. The error names the path and says to inspect rather than
  delete it. This matches the absent-vs-corrupt distinction already applied to `account.json`.
- **`max_toll_usd` in account-key mode.** A *configured default* (`AGENTSCOUT_MAX_TOLL_USD`, or the
  plugin's `max_toll_usd`) is now ignored in account-key mode, as the plugin already documented.
  It was previously applied unconditionally, which made `scout_read`, `scout_extract` and
  `scout_crawl` all throw `tolls_require_x402` before issuing a request — one configuration field
  silently disabled the entire paid surface. An *explicitly requested* `max_toll_usd` is still
  refused, since silently dropping a cap the caller asked for on a paid verb would be worse.
- **The paid MCP tools now declare `destructiveHint: false`.** The field defaults to `true` per the
  MCP specification, so `scout_read`, `scout_extract` and `scout_crawl` were advertising a web
  fetch as potentially destructive. `readOnlyHint` is unchanged and remains truthful: a paid verb
  is never marked read-only.

### Added

- **`agentscout wallet`, plus a read-only `scout_wallet_address` MCP tool.** The CLI mints a wallet
  on first use that must hold real USDC, but nothing exposed its address to fund it or its path to
  back it up. Both report the address, where it came from, and what to do next — never the private
  key.

### Fixed

- **The cumulative session spend cap now holds under concurrency.** `maxSessionSpendUsd` was
  checked against a counter incremented only *after* a paid round-trip, so concurrent operations
  all tested the same stale value, all passed, and all signed: three in-flight reads authorized
  $0.012 against a $0.005 cap. The check now takes a synchronous reservation that is released when
  the operation settles or fails. This was reachable in normal use — the MCP server builds one
  client for its whole lifetime, so parallel tool calls share the counter, and a crawl commits
  `max_pages` × the per-page price at once.
- **A malformed spend cap in `config.json` is rejected even when a flag or environment variable
  overrides it**, so a typo in a persisted cap surfaces at once rather than at whatever later
  command omits the override.

## [0.4.0] — 2026-07-30

> Previewed as `0.4.0-rc.1` under the `next` dist-tag before this release; the contents are identical.

### Added

- New `ScoutErrorCode` members surfaced from the `@agentx402-ai/core` 0.2.0 payment/transport
  guards: `network_error`, `aborted`, `unpinned_network`, `unsupported_network`, `network_mismatch`,
  `asset_mismatch`, `domain_mismatch`, `invalid_challenge`, `invalid_amount`. A client that pins its
  network and signs an honest challenge never sees these — they identify a spoofed/mismatched
  challenge or a transport failure.

### Changed

- Dependency floor `@agentx402-ai/core` raised to `^0.2.0`: safe-by-default money path (the
  network + canonical-asset pin is now required before an EIP-3009 authorization is signed), a
  typed challenge taxonomy, and abort-aware retry. AgentScout's own API is unchanged apart from the
  added error codes above.

### Fixed

- **Spend caps and tolls fail closed on a malformed value.** A non-finite `maxSpendUsd`,
  `maxSessionSpendUsd`, or `maxTollUsd` (e.g. `NaN` from a bad parse, or a non-numeric value in
  `config.json`) used to silently disable the cap — the exact "malformed cap becomes unlimited"
  hole the caps exist to prevent. Such a value now throws `invalid_config` at construction or before
  the request, and never signs.
- **Async extraction** now returns the fetched page URL (was the job id) and carries the usage/toll
  accounting through; the transparent poll loop is bounded by `maxWaitMs` and no longer rejects
  `extract()` with a raw `TypeError` on a transient network error.

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
