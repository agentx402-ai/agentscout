# AGENTS.md — agent/contributor guide for this repo

Cross-tool agent instructions (the [agents.md](https://agents.md) convention).
`CLAUDE.md` references this file; keep tool-specific notes there, shared truth here.

## What this repo is

Open-source **client surface** for AgentScout — an agent-native, x402-paid web
read/extract/crawl service (service at `api.agentx402.ai/v1/scout/*`; the server is not in
this repo). npm-workspaces monorepo:

| Workspace | Package | What it is |
|---|---|---|
| `client/` | `@agentscout/client` | SDK — x402 payments, spend caps, read/extract/quote/crawl |
| `cli/` | `@agentscout/cli` | CLI + `agentscout mcp` MCP server (wraps the client) |
| `plugin/` | (not published to npm) | Claude Code plugin wrapping the MCP server |

`@agentx402-ai/core` (shared x402/EIP-712 platform SDK) lives in its own repo
(`agentx402-ai/core`) and is consumed as a normal dependency.

## Commands

```bash
npm ci                 # install (root; workspaces hoisted)
npm run build          # client then cli (order matters — cli depends on client)
npm run typecheck      # tsc --noEmit, both workspaces
npm test               # builds client first (pretest), then client + cli suites (vitest)
npm run lint           # biome ci .   (CI gate — run before pushing)
npm run format         # biome check --write .
npm --workspace client test -- spend-caps   # one file, vitest filename filter
```

Git hooks come from `.githooks/` (wired by `npm ci` via `core.hooksPath`).

## Conventions

- TypeScript, ESM, Biome for lint+format. Match the existing comment density — this
  codebase explains *why*, especially around payment logic.
- Conventional commits: `type(scope): subject` (`feat(client): …`, `fix(cli): …`),
  imperative, with a short explanatory body for anything non-obvious. No trailers.
- Tests live in `<workspace>/test/`, colocated by feature (`spend-caps.test.ts`,
  `payto.test.ts`, …). New behavior ships with tests; bug fixes ship with a
  regression test that fails on the pre-fix code.
- This is a public repo: no scratch files, planning notes, or internal references in
  commits. `.superpowers/` is gitignored scratch — leave it that way.

## Money-safety invariants (do not weaken)

Client code here authorizes real USDC payments. Four invariants are load-bearing:

1. **Spend caps bound every paying path.** `maxSpendUsd` / `AGENTSCOUT_MAX_SPEND_USD`
   (per call) and `maxSessionSpendUsd` / `AGENTSCOUT_MAX_SESSION_SPEND_USD` (cumulative)
   are checked BEFORE the challenge is signed; an over-cap op throws `SpendCapError`,
   it never silently caps. A malformed cap value fails closed (throws), never "unlimited".
2. **`expectedPayTo` pins the recipient.** When set, a `402` challenge whose `payTo`
   differs is rejected (`payto_mismatch`) BEFORE the EIP-3009 authorization is signed.
3. **`maxTollUsd` is wallet-mode only.** In account-key mode, setting it throws a
   client-side `tolls_require_x402` BEFORE any request is issued — an `ak_` caller
   cannot front a real-USDC publisher toll.
4. **The SDK signs the challenge's exact amount.** The server's `402`-quoted price is
   signed verbatim (`buildPaymentHeader` pins the network, the canonical USDC token, and
   `expectedPayTo`); the SDK never signs a self-computed sum. `quote` never signs or spends.

Error-code strings (`insufficient_credits`, `payto_mismatch`, `tolls_require_x402`, …) and
the x402/EIP-712 domain constants are pinned to the server's canon; parity tests here mirror
server behavior. Never rename or repurpose one unilaterally — client and service must change
in lockstep. The deterministic regressions in `client/test/spend-caps.test.ts` and
`client/test/payto.test.ts` pin invariants 1–2; if your change breaks one, the change is
wrong, not the test.

## Versioning & release

`RELEASING.md` is authoritative. Five in-repo version sources move in lockstep — both
`package.json`s, `client/src/index.ts` `VERSION`, `cli/src/version.ts` `VERSION`,
`plugin/agentscout/.claude-plugin/plugin.json` `version` — plus a sixth cross-repo pin, the
marketplace `source.ref` synced on release. CI's `versions` job cross-checks ALL FIVE in-repo
sources AND the cli→client dependency range (`@agentscout/client` must be `^<clientVersion>`);
update them together, by hand. Publishing happens via a GitHub Release → the `publish.yml`
OIDC trusted-publishing workflow (client before cli — dependency order). Never `npm publish`
from a laptop.

## Security

See `SECURITY.md`. Never print, log, or commit account keys (`ak_…`) or wallet private keys —
in code, tests, or your own command output. Secrets are read from env / the local keystore
only, never from CLI flags or the config file. Scout content is **not** encrypted (it is
public web data). Report vulnerabilities per `SECURITY.md`, not via public issues.
