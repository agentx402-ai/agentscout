import type { Signer, UsageBlock } from "@agentx402-ai/core";

export type { Signer, UsageBlock };

interface AgentScoutCommon {
  /** REQUIRED. No SDK default — the CLI/plugin layer supplies https://api.agentx402.ai. Trailing slashes trimmed. */
  endpoint: string;
  /** CAIP-2 network id. Default "eip155:8453" (Base mainnet). */
  network?: string;
  /** Per-paying-call USD ceiling on the server-quoted price; throws SpendCapError if exceeded. */
  maxSpendUsd?: number;
  /** Cumulative USD ceiling across this client (best-effort in-memory counter). */
  maxSessionSpendUsd?: number;
  /**
   * Pin the x402 payment recipient. Any 402 challenge whose payTo differs is rejected
   * (payto_mismatch) BEFORE the EIP-3009 authorization is signed. Checksummable EVM address,
   * validated at construction (invalid_config).
   */
  expectedPayTo?: string;
  /** Bounded retries on TRANSIENT failures (thrown fetch / 5xx / 429). Default 2 (3 attempts). 0 disables. */
  retries?: number;
  /** Per-attempt request timeout in ms. Default (core) 30000. 0 disables. */
  timeoutMs?: number;
  /** Injectable fetch for proxies / instrumentation / tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Exactly one auth shape. No encryption ⇒ no encryptionKey, no { privateKey } shape (CLI converts raw keys to a signer). */
export type AgentScoutOptions = AgentScoutCommon & ({ signer: Signer } | { accountKey: string });

// ---- Result + param types (shared by the verb tasks) ----

/** Toll cost breakdown — present ONLY on toll-path (max_toll_usd > 0) 200s. */
export interface TollAccounting {
  toll_paid_atomic: number;
  tx_hash: string | null;
  rail: "x402";
}

/** One outbound link found on the page.
 *
 * Collected deterministically while parsing the HTML — never by an LLM — so an href here
 * is one that genuinely appears on the page rather than one a model produced. Hrefs are
 * absolute, deduplicated, restricted to http(s), and capped at 200 in document order. */
export interface PageLink {
  text: string;
  href: string;
}

export type ReadResult = {
  url: string;
  markdown: string;
  title?: string;
  tokens: number;
  cache_hit: boolean;
  /** Present only when `links: true` was requested.
   *
   * Also ABSENT (not empty) when the page had to be rescued by browser rendering: that
   * path returns rendered markdown whose anchors were never parsed, so reporting the
   * pre-render set would describe a document you did not receive. Distinguish "no links
   * requested / not available" (undefined) from "page genuinely has none" ([]). */
  links?: PageLink[];
} & ({ usage: UsageBlock; toll?: undefined } | { toll: TollAccounting; usage?: undefined });

/** How the extraction was produced. Present on the pay-on-success (non-toll) path.
 *
 * `input_truncated` is the one to actually branch on: a page over the service's input
 * cap is CUT and the ladder runs on the first ~16K tokens, so a `true` here means your
 * JSON was derived from a PARTIAL document — you paid full price either way. Treat a
 * truncated result as lower-confidence for anything that might appear late in the page.
 *
 * `winning_rung` says which model produced it: "8b" (cheapest, first attempt), "repair"
 * (second 8B pass), "70b" (escalated), or "json" (browser-rendered structured pass). An
 * answer from `8b` and one rescued by `70b` are not equally trustworthy. */
export interface ExtractionMeta {
  input_truncated: boolean;
  /** Which ladder rung produced the answer. `chunked` means the document was too large
   * for one pass and was read across several, then merged. */
  winning_rung: "8b" | "repair" | "70b" | "json" | "chunked" | "none" | "unknown";
  /** Number of passes, present only on the `chunked` path. */
  chunks?: number;
  /** Scalar fields where two passes disagreed and one was chosen by POSITION rather
   * than by being more likely true.
   *
   * Treat a non-zero value as "part of this answer is a guess". Merging across passes
   * also cannot compute document-global aggregates — a "total" answered by one pass is
   * that pass's partial figure, not the whole document's — so a schema asking for
   * totals, counts, or superlatives over a large page is the case to verify yourself. */
  merge_conflicts?: number;
}

/** Result of an extraction.
 *
 * ACCURACY GUARANTEE, and its limits. Extracted values that look like page literals —
 * short, space-free identifiers such as tickers, codes and ids — are verified against
 * the fetched page and DROPPED if they do not appear in it. A measured run that
 * returned six fabricated ticker symbols returns none after this check.
 *
 * That check is narrow on purpose, and you should know both halves:
 *  - It only inspects token-like strings. Prose is never checked, because a model
 *    legitimately assembles "San Francisco, California, U.S." from scattered cells and
 *    demanding it appear verbatim would delete correct answers.
 *  - It only removes ARRAY ITEMS, never object fields, since removing a field would
 *    break a `required` schema.
 *
 * So a schema-valid result is still a SHAPE guarantee plus a literal-token check — not
 * a truth guarantee. Prose values, numbers and anything the model paraphrased are not
 * verified against the source. */
export type ExtractResult = { url: string; data: unknown; extraction?: ExtractionMeta } & (
  | { usage: UsageBlock; toll?: undefined }
  | { toll: TollAccounting; usage?: undefined }
  // Async multi-pass completions may carry NO accounting block: payment settles server-side and the
  // status route can report only the result. Accounting is present on the single-pass (sync) path
  // and optional on the polled async path — narrow on `"usage" in result` / `"toll" in result`.
  | { usage?: undefined; toll?: undefined }
);

/** All four branches are HTTP 200. Prices are ATOMIC USDC integers (6 decimals), NOT USD. */
export interface QuoteResult {
  toll_price: number | null;
  settle_fee: number | null;
  total: number | null;
  rail: "x402" | null;
  would_pay: boolean;
  advisory: true;
  payee_sanctioned?: true;
  hint: string;
  ts: number;
}

export interface ReadOptions {
  maxTollUsd?: number;
  maxTokens?: number;
  fresh?: boolean;
  /** Return outbound links as structured data. Off by default.
   *
   * Costs nothing extra — links are extracted while the HTML is already being parsed,
   * and they are never fed to the model. `extract` never enables this: inlining URLs
   * into an extraction prompt measured +58% input tokens on a link-heavy article, which
   * would worsen truncation and cost accuracy. */
  links?: boolean;
}
export interface ExtractOptions {
  instructions?: string;
  maxTollUsd?: number;
  /** How long to wait for an async multi-pass extraction before giving up. Default
   * 120s.
   *
   * A document too large for a single pass is extracted server-side as a job, and the
   * SDK polls it transparently. Giving up here loses patience, not the extraction:
   * the job keeps running and its result stays readable at the status url reported on
   * the thrown error. Polling is free — you are charged once, only if the job
   * produces a schema-valid result. */
  maxWaitMs?: number;
}

export interface CrawlOptions {
  /** REQUIRED — price-determining (max_pages × $0.004), sent as ?max_pages=N (query-only). Integer 1..MAX_CRAWL_PAGES. */
  maxPages: number;
  /** Wallet-mode only; query-only (?max_toll_usd=). */
  maxTollUsd?: number;
  /** POST-body same_origin; worker default true. false → cross-origin crawl. */
  sameOrigin?: boolean;
  /** POST-body vectorize; accepted by the worker, reserved. */
  vectorize?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface CrawlCompleteBody {
  job_id: string;
  seed_url: string;
  same_origin: boolean;
  max_pages: number;
  vectorize: boolean;
  requested_at: number;
  completed_at: number;
  pages_crawled: number;
  pages_ok: number;
  pages_failed: number;
  pages: Array<{
    url: string;
    ok: boolean;
    reason?: string;
    title?: string;
    tokens?: number;
    bytes?: number;
    key?: string;
    url_artifact?: string;
  }>;
  budget: { max_pages: number; billable_pages: number; unused_pages: number };
  tolls_paid_atomic: number;
  unused_toll_atomic: number;
  tolls: Array<{ url: string; priceAtomic: number; feeAtomic: number; txHash: string }>;
  tolls_skipped: Array<{ url: string; totalAtomic: number; reason: string }>;
  corpus_prefix: string;
  manifest_url: string;
}

export type CrawlOutcome =
  | ({ status: "complete"; jobId: string } & CrawlCompleteBody)
  | { status: "pending"; jobId: string };

export type CrawlStatus =
  | ({ status: "complete" } & CrawlCompleteBody)
  | { job_id: string; status: string; error?: string };
