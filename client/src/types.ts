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

export type ReadResult = {
  url: string;
  markdown: string;
  title?: string;
  tokens: number;
  cache_hit: boolean;
} & ({ usage: UsageBlock; toll?: undefined } | { toll: TollAccounting; usage?: undefined });

export type ExtractResult = { url: string; data: unknown } & (
  | { usage: UsageBlock; toll?: undefined }
  | { toll: TollAccounting; usage?: undefined }
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
}
export interface ExtractOptions {
  instructions?: string;
  maxTollUsd?: number;
}

export interface CrawlOptions {
  /** REQUIRED — price-determining (max_pages × $0.002), sent as ?max_pages=N (query-only). Integer 1..MAX_CRAWL_PAGES. */
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
