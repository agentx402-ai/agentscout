# @agentscout/client

The TypeScript SDK for [AgentScout](https://github.com/agentx402-ai/agentscout) — an agent-native
web **read / extract / crawl** service paid per fetch over [x402](https://x402.org). Give it a URL
and get back clean **markdown**, structured **JSON** validated against your schema, a **free**
price probe, or a whole-site **crawl** — every paid fetch settling in **USDC** on Base, with no
signup and no API keys.

**Wallet-native by default** — a signable EVM wallet pays each fetch inline via x402 — with an
opt-in **account-key mode** (an `ak_…` bearer token that debits prepaid credits, funded out-of-band
via AgentKV) for managed wallets that can't sign. Scout content is **not** encrypted — it is public
web data by definition; a response is plaintext.

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

// crawl → walk a site up to maxPages, get a results manifest (long crawls return a resumable jobId)
const result = await scout.crawl("https://example.com", { maxPages: 10 });
```

### Account-key mode (managed wallets that can't sign)

Pass an `ak_…` bearer token instead of a wallet. The bearer is the identity and each fetch debits
the account's prepaid credits; any signing wallet funds it out-of-band via AgentKV.

```ts
const scout = new AgentScout({
  accountKey: process.env.AGENTSCOUT_ACCOUNT_KEY as string, // ak_<64 hex>
  endpoint: "https://api.agentx402.ai",
});

const { markdown } = await scout.read("https://example.com"); // bearer-authenticated; debits credits
```

An `insufficient_credits` `402` throws a typed error (fund the account out-of-band via AgentKV —
the SDK has no funding path). Publisher tolls (`maxTollUsd`) are **wallet-mode only**: an `ak_`
caller cannot front a real-USDC toll, so setting one in account-key mode fails fast
(`tolls_require_x402`) before any request is issued.

### Verbs

- **`quote(url)`** — free; prices a URL without signing or spending. All branches are HTTP 200;
  prices are atomic USDC.
- **`read(url, { maxTollUsd?, maxTokens?, fresh? })`** — fetch → clean markdown.
- **`extract(url, schema, { instructions?, maxTollUsd? })`** — fetch → LLM → JSON validated against
  `schema` (a JSON Schema object).
- **`crawl(url, { maxPages, maxTollUsd?, sameOrigin?, timeoutMs?, pollIntervalMs? })`** — crawl a
  site (`maxPages` is required and price-determining). Also `crawl.submit`, `crawl.status(jobId)`,
  `crawl.artifact(jobId, key)`, and `crawl.wait(jobId)` for resuming a long job.

### Money-safety

- **The SDK signs the challenge's exact quoted amount** — never a self-computed sum — pinning the
  network, the canonical USDC token, and (when you set `expectedPayTo`) the recipient before
  signing. A `402` quoting more than the caller authorized (pinned base price + the `maxTollUsd`
  actually sent) is refused **before any signature**, even with no `maxSpendUsd` set.
- **Spend caps.** `maxSpendUsd` (per call) and `maxSessionSpendUsd` (cumulative across the client)
  throw `SpendCapError` before the challenge is signed.

See the [monorepo README](https://github.com/agentx402-ai/agentscout#readme) for the CLI, MCP
server, and Claude plugin.

## License

[MIT](./LICENSE)
