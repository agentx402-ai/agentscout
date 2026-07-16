# AgentScout Claude plugin

A [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that gives agents
x402-paid access to the live web — exposed as five MCP tools: `scout_read` (a URL to clean
markdown), `scout_extract` (a URL to structured JSON against a schema), `scout_crawl` (walk a
site to a results manifest), the free `scout_quote` (price a fetch before spending), and the
free `scout_crawl_status` (resume a long crawl by `jobId`). Fetches are paid per call in USDC
via x402 — wallet-native by default, with an opt-in account-key (`ak_` bearer) mode for managed
wallets. Scout content is **not** encrypted (it is public web data).

> **Prerequisite:** the plugin runs `npx -y @agentscout/cli mcp`, so [`@agentscout/cli`](../cli)
> must be published to npm (or resolvable via `npx`). It is **not yet published** — until then,
> use the local-checkout method in step 1.
>
> **Windows:** `.mcp.json` uses `"command": "npx"`. Claude Code's MCP launcher resolves the
> `npx.cmd` shim on Windows automatically, so this works as-is. Other MCP clients that spawn the
> command naively (`child_process.spawn("npx", …)` without `shell: true`) throw `ENOENT` on
> Windows, since only `npx.cmd` exists on `PATH`. If you wire this server into such a client,
> set the command to `npx.cmd` (or `cmd /c npx`) there.

## Install

**1. Add the marketplace and install the plugin** — run these in Claude Code:

```text
/plugin marketplace add agentx402-ai/claude-plugins
/plugin install agentscout@agentx402
```

<details>
<summary>From a local checkout (for development)</summary>

```bash
git clone https://github.com/agentx402-ai/agentscout
cd agentscout && npm ci && npm run build
claude --plugin-dir ./plugin/agentscout
```

</details>

**2. Enter credentials when prompted.** On install, Claude Code asks for the plugin's config and
threads it into the MCP server for you — **no shell environment variables to set**:

| Prompt | Required | Notes |
|--------|----------|-------|
| Wallet private key | No | Optional — leave blank and AgentScout mints + manages a local wallet on first use. To bring your own: an EVM hex key, masked + stored in your OS keychain |
| Account key | No | An `ak_…` bearer token for managed-wallet (credit) mode; funded out-of-band via AgentKV. Mutually exclusive with a wallet key |
| AgentScout endpoint | No | Defaults to `https://api.agentx402.ai` (the hosted service) |
| Network | No | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia testnet) |
| Max per-operation spend (USD) | No | refuses any single fetch costing more than this; leave empty for no per-op cap |
| Max session spend (USD) | No | refuses further fetches once cumulative spend across the whole MCP session exceeds this; leave empty for no session cap |
| Max publisher toll (USD) | No | caps the publisher toll on a paid fetch; wallet mode only (rejected in account-key mode) |

Don't have a wallet? Leave "Wallet private key" blank — AgentScout mints and manages a local
wallet on first use — then fund the address it prints (step 4).
To change any of these later, run `/plugin` and reconfigure the `agentscout` plugin.

**3. Verify it loaded:**

```text
/mcp
```

You should see the `agentscout` server **connected** with its five tools.

**4. Fund the payer.** In **wallet mode**, send USDC to your wallet address on Base — reads,
extracts, and crawls are then paid inline per fetch via x402. In **account-key mode**, scout has
no deposit route of its own: fund the `ak_` account out-of-band via AgentKV by depositing to
`https://api.agentx402.ai/v1/account/deposit` under your bearer, and scout debits those shared
credits.

> **Managed wallets / account-key mode.** For a managed wallet that can't sign, AgentScout
> supports an opt-in **account-key** mode (an `ak_…` bearer token identifies the account, funded
> by any signing wallet through AgentKV). In that mode publisher tolls cannot be fronted, so
> `max_toll_usd` is refused client-side (`tolls_require_x402`) before any request is issued. See
> the skill's **Account-key mode & funding** section for setup.

See the [skill](./agentscout/skills/agentscout/SKILL.md) for the full tool reference, pricing,
spend-cap guidance, account-key/managed-wallet setup, and the resumable-crawl pattern.

## Layout

- [`agentscout/`](./agentscout) — the plugin:
  [`.claude-plugin/plugin.json`](./agentscout/.claude-plugin/plugin.json) (manifest + config
  schema), [`.mcp.json`](./agentscout/.mcp.json) (MCP server wiring), and the
  [skill](./agentscout/skills/agentscout/SKILL.md).
- The plugin is published through the shared **agentx402 marketplace**
  ([`agentx402-ai/claude-plugins`](https://github.com/agentx402-ai/claude-plugins)), which
  references this directory by `git-subdir`. This repo carries no marketplace manifest of its own.

## License

[MIT](../LICENSE)
