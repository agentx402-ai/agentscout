# Security Policy

The AgentScout clients sign real USDC payment authorizations over x402, so we take security
reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via either:

- GitHub's [private vulnerability reporting](https://github.com/agentx402-ai/agentscout/security/advisories/new)
  (preferred), or
- email **contact@agentx402.ai** with a subject starting `SECURITY:`.

Please include a description, the affected package(s) and version(s), reproduction steps, and the
impact. We aim to acknowledge within 72 hours and will keep you updated through remediation. Please
give us a reasonable window to ship a fix before any public disclosure.

## Scope

This repository contains the **client** surface — `@agentscout/client` (SDK), `@agentscout/cli`
(CLI + MCP server), and the Claude plugin. The hosted AgentScout service backend is operated
separately and is out of scope here. In scope: the client's signing, payment-authorization
handling, spend-cap and payee-pinning logic, key management, and dependency vulnerabilities.

## Threat model

The SDK signs **real USDC payment authorizations** (EIP-3009 `transferWithAuthorization`) to pay
for each fetch over x402. The guardrails against overspend are client-side, and they are what a
review must scrutinize hardest:

- **The SDK signs the server's exact quoted amount**, taken verbatim from the `402` challenge —
  never a self-computed sum. `buildPaymentHeader` pins the expected network and the canonical USDC
  token before signing, so a challenge that names a different chain or token is rejected.
- **Spend caps refuse, never silently cap.** `maxSpendUsd` / `AGENTSCOUT_MAX_SPEND_USD` (per call)
  and `maxSessionSpendUsd` / `AGENTSCOUT_MAX_SESSION_SPEND_USD` (cumulative) are checked BEFORE the
  challenge is signed; an over-cap op throws and signs nothing. A malformed cap value fails closed
  (throws) rather than becoming "unlimited".
- **`expectedPayTo` pins the recipient.** When set, any `402` challenge whose `payTo` differs is
  rejected (`payto_mismatch`) before the authorization is signed, so a spoofed or swapped payee
  cannot be paid.
- **Publisher tolls are wallet-mode only.** A publisher toll is fronted in real USDC by the paying
  wallet; an account-key (`ak_`) caller has no wallet to front it, so setting `maxTollUsd` in
  account-key mode fails fast client-side (`tolls_require_x402`) **before any request is issued** —
  it never silently proceeds unpaid or overspends.

**Content is NOT encrypted.** Unlike AgentKV — which encrypts values client-side so the server is
zero-knowledge — AgentScout fetches and returns **public web content in the clear**. There is no
encryption key and nothing zero-knowledge about a scout response: the service, and a network
observer of the client↔server hop, both see the fetched content. Do not treat a scout result as
private, and do not use AgentScout to move secrets.

**The account-key bearer is a full-ownership secret.** In the opt-in account-key mode, the raw
`ak_…` bearer token (`AGENTSCOUT_ACCOUNT_KEY`) *is* the account identity — presenting it lets the
holder spend the account's prepaid credits. Treat it with the same care as a wallet private key:
keep it (and the wallet key `AGENTSCOUT_PRIVATE_KEY`) in env or a secret manager, never a config
file or source control.

**Secrets are read from env / the local keystore only** — never from CLI flags or the config
file. The MCP server **scrubs the wallet and account keys from its own environment at startup**
(once the client has captured them), so an agent-controlled child process cannot read them back;
the secret-source guards also **refuse to read protected key material** (`AGENTSCOUT_PRIVATE_KEY` /
`AGENTSCOUT_ACCOUNT_KEY`, or any `AGENTSCOUT_*` var whose name looks like key material), the
keystore directory, and pseudo-filesystem paths (`/proc`, `/sys`). Keystore files are written
`0600` in a `0700` directory.

## Known advisories

`npm audit` may report a high-severity advisory for **`ws`** (GHSA-96hv-2xvq-fx4p), pulled in
transitively through `viem`. AgentScout's client uses `viem` **only for signing and address/hash
utilities** and never opens a WebSocket transport, so the affected code path is not reachable from
this SDK. This repository pins a patched `ws` via an `overrides` entry; downstream consumers resolve
`ws` through their own dependency tree, so keep `viem`/`ws` up to date (Dependabot is enabled here).

## Supported versions

The latest released minor of each `@agentscout/*` package receives security fixes.
