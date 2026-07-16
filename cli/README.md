# @agentscout/cli

The command-line client and MCP server for
[AgentScout](https://github.com/agentx402-ai/agentscout) — an agent-native web
**read / extract / crawl** service paid per fetch over [x402](https://x402.org).

No setup: AgentScout mints and manages a local wallet for you on first run and defaults to the
hosted service. Just run a command:

```bash
npx @agentscout/cli quote https://example.com          # free price probe (no spend)
agentscout read https://example.com                    # → clean markdown (paid per fetch)
agentscout extract https://example.com --schema ./schema.json
agentscout crawl https://example.com --max-pages 10
agentscout crawl status <jobId>                        # resume a long crawl
agentscout crawl artifact <jobId> <key> [--out FILE]   # fetch one crawl artifact
```

Prefer to bring your own wallet? Set `AGENTSCOUT_PRIVATE_KEY=0x…`; set `AGENTSCOUT_ENDPOINT` to
point at a different service.

No wallet set? AgentScout mints and manages a local wallet on first use (a `0600` keystore under
`~/.agentscout`) and prints its address — fund that address with USDC on Base, then retry.

## Two ways to pay (auto-detected)

- **Wallet-as-payer** (default): a signable wallet pays each fetch inline via x402 and is itself the
  identity. The auto-provisioned wallet uses this.
- **Account-key**: for a *managed* wallet that can't sign (e.g.
  [awal](https://www.npmjs.com/package/awal)), an opaque `ak_…` bearer token is the identity and
  fetches debit **prepaid credits** funded out-of-band via AgentKV.

```bash
# Fund an account out-of-band from ANY signing wallet (via AgentKV), then use just the bearer:
export AGENTSCOUT_ACCOUNT_KEY=ak_...
agentscout read https://example.com                    # debits the account's prepaid credits
```

Account-key mode is selected when `AGENTSCOUT_ACCOUNT_KEY` is set (or a stored `account.json`
exists and no `AGENTSCOUT_PRIVATE_KEY` is set); an explicit `AGENTSCOUT_PRIVATE_KEY` keeps wallet
mode.

## Publisher tolls

Some publishers charge a per-fetch **toll** on top of the base price. `--max-toll-usd N` caps the
real-USDC toll the fetch will front (also settable as the `AGENTSCOUT_MAX_TOLL_USD` default; an
explicit `--max-toll-usd` overrides it). Tolls are **wallet-mode only** — an `ak_` account-key
caller cannot front a real-USDC toll, so setting one in account-key mode fails fast
(`tolls_require_x402`) before any request is issued.

## Configuration

Secrets come from the environment only — never the config file.

| Variable | Description |
|----------|-------------|
| `AGENTSCOUT_PRIVATE_KEY` | Wallet key (hex). Unset → a local wallet is auto-provisioned on first use. |
| `AGENTSCOUT_ACCOUNT_KEY` | `ak_…` bearer token — selects account-key mode. |
| `AGENTSCOUT_ENDPOINT` | Service URL; defaults to `https://api.agentx402.ai`. |
| `AGENTSCOUT_NETWORK` | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia). |
| `AGENTSCOUT_MAX_SPEND_USD` | Per-fetch USD spend cap. A malformed value fails closed. |
| `AGENTSCOUT_MAX_SESSION_SPEND_USD` | Cumulative, instance-lifetime USD cap (opt-in). |
| `AGENTSCOUT_MAX_TOLL_USD` | Default publisher-toll cap (USD, wallet mode only). Overridden per call by `--max-toll-usd`. |
| `AGENTSCOUT_HOME` | Base dir for the local keystore/config (default `~/.agentscout`). |

## MCP server

`agentscout mcp` runs an MCP server over stdio exposing `scout_read`, `scout_extract`, and
`scout_crawl` (the three paid fetch verbs), plus the free `scout_quote` (price a fetch before
spending) and `scout_crawl_status` (resume a long crawl by `jobId`), to Claude Desktop / Code /
Cursor and any MCP client.

The paid verbs are annotated as **state-changing** (never `readOnlyHint`) so a client knows to
prompt a human before spending; `scout_quote` and `scout_crawl_status` are read-only. The wallet /
account key is scrubbed from the server's own environment at startup so an agent-controlled child
process can never read it back.

See the [monorepo README](https://github.com/agentx402-ai/agentscout#readme) for the SDK and the
Claude plugin.

## License

[MIT](./LICENSE)
