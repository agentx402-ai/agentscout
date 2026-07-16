# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [SemVer](https://semver.org/).

## [0.1.0] — 2026-07-16

### Added
- `@agentscout/client` SDK: `read`, `extract`, `quote`, `crawl` over the AgentScout x402-paid service, wrapping `@agentx402-ai/core`'s caller-side payment helpers. Wallet (x402) and account-key (`ak_`) auth. Client-side spend caps + `expectedPayTo` recipient pinning.
- `@agentscout/cli` (`@agentscout/cli`): `agentscout read|extract|quote|crawl` + the `agentscout mcp` MCP server (5 tools with truthful paid/read-only annotations).
- Claude Code plugin (`plugin/agentscout`).

### Security
- Publisher tolls (`maxTollUsd`) are wallet-mode only; account-key mode fails fast client-side (`tolls_require_x402`). Secrets read from env/keystore only; error paths redact bearers.
