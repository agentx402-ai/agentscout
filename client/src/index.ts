import { fetchWithRetry as coreFetchWithRetry } from "@agentx402-ai/core";
import { getAddress } from "viem";
import { isAccountKeyFormat } from "./account";
import { type Crawl, makeCrawl } from "./crawl";
import { AgentScoutError, SpendCapError, scoutErrorFromResponse } from "./errors";
import {
  buildBearerHeaders,
  buildPaymentHeader,
  challengePriceUsd,
  freshNonce,
  nonceFromIdempotencyKey,
} from "./payment";
import type {
  AgentScoutOptions,
  ExtractionMeta,
  ExtractOptions,
  ExtractResult,
  QuoteResult,
  ReadOptions,
  ReadResult,
  Signer,
  TollAccounting,
  UsageBlock,
} from "./types";

export const VERSION = "0.4.0";

export { generateAccountKey, isAccountKeyFormat } from "./account";
export {
  AgentScoutError,
  AgentXError,
  type ScoutErrorCode,
  SpendCapError,
  scoutErrorFromResponse,
} from "./errors";
export * from "./types";

const DEFAULT_NETWORK = "eip155:8453";

// Canonical scout base path on the shared platform host: /v1/scout/<verb>. The client cannot
// import the worker's paths.ts across packages, so this literal mirrors SCOUT_BASE and is pinned
// by the routing assertions in the verb tests.
const V1 = "/v1/scout";

// Pinned scout base prices (USD) — used only for client-side pre-request cap math. The wire
// price always comes from the server's 402 challenge; these are a conservative lower bound.
// (worker: registerService("scout", { read: 4_000, … }) → read = 4000 atomic = $0.004.)
// MUST track the worker's scout:read atomic price. This is not merely informational: it is the
// `authorizedCeilingUsd` for a plain read, so pinning it BELOW the server's real quote makes the
// client refuse every honest 402 with SpendCapError. Raised 0.002 → 0.003 with the worker's
// 2026-07-25 read-price recalibration, then 0.003 → 0.004 on 2026-07-26.
//
// BECAUSE this is a ceiling, a price INCREASE must reach callers BEFORE the worker quotes it:
// an un-updated client refuses the new, honest 402 as a SpendCapError. Ship the SDK first.
const READ_BASE_USD = 0.004;
// Pinned scout extract base price (USD) — client-side pre-request cap math only.
// (worker: registerService("scout", { extract: 20_000, … }) → extract = 20000 atomic = $0.020.)
// Raised 0.012 → 0.020 on 2026-07-26: extract is the only verb whose worst-case ladder cost can
// approach its price, and 5:1 against read is the market's extract:scrape convention.
const EXTRACT_BASE_USD = 0.02;

// Built-in op-price ceiling (USD): when no explicit maxSpendUsd is set, a wallet-mode op refuses a
// server-quoted 402 amount above this. Backstop against a spoofed / compromised / MITM'd challenge
// draining the wallet in the default (no-cap) config. Mirrors @agentkv/client's DEFAULT_MAX_OP_USD.
const DEFAULT_MAX_OP_USD = 0.05;
// Float/rounding slack (USD, ~1 atomic USDC) for the authorized-ceiling check. The worker quantizes
// the quoted total DOWN to whole credits, so an honest quote is always ≤ base + toll; this only
// absorbs sub-atomic float error so an exact honest quote is never falsely refused.
const PRICE_EPS = 0.000001;

/** 202 handoff shape for an extraction that needs multiple passes. */
interface AsyncExtractJob {
  job_id: string;
  status: string;
  status_url: string;
}

function isAsyncJob(v: unknown): v is AsyncExtractJob {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as AsyncExtractJob).job_id === "string" &&
    typeof (v as AsyncExtractJob).status_url === "string"
  );
}

/**
 * Fail closed on a malformed money bound. A spend cap or toll budget that is not a finite,
 * non-negative number is REJECTED here — never stored and silently ignored. Money-safety
 * invariant 1: a malformed cap fails closed, never "unlimited". The dangerous value is a
 * non-finite one — `usd > NaN` is always false, so an unchecked NaN would void every downstream
 * price guard. Mirrors the CLI's config.ts numOrThrow at the SDK boundary (a direct SDK consumer,
 * or the unvalidated config.json path, can hand the constructor any value).
 */
function assertFiniteUsd(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentScoutError(`${label} must be a non-negative finite number`, "invalid_config", 0);
  }
}

export class AgentScout {
  readonly endpoint: string;
  readonly network: string;
  readonly signer?: Signer;
  readonly accountKey?: string;
  readonly maxSpendUsd?: number;
  readonly maxSessionSpendUsd?: number;
  readonly expectedPayTo?: `0x${string}`;
  readonly maxRetries: number;
  protected readonly timeoutMs?: number;
  protected readonly fetchImpl?: typeof fetch;
  protected sessionSpentUsd = 0;
  readonly crawl: Crawl;

  constructor(opts: AgentScoutOptions) {
    if (!opts?.endpoint) throw new AgentScoutError("endpoint is required", "invalid_config", 0);
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.network = (opts as { network?: string }).network ?? DEFAULT_NETWORK;
    this.maxSpendUsd = (opts as { maxSpendUsd?: number }).maxSpendUsd;
    this.maxSessionSpendUsd = (opts as { maxSessionSpendUsd?: number }).maxSessionSpendUsd;
    // Fail closed on a malformed cap: a non-finite/negative value must throw at construction,
    // never be stored (a NaN cap makes every `usd > cap` check false → unlimited spend, and also
    // silently disables the DEFAULT_MAX_OP_USD backstop, which only runs when maxSpendUsd is unset).
    assertFiniteUsd(this.maxSpendUsd, "maxSpendUsd");
    assertFiniteUsd(this.maxSessionSpendUsd, "maxSessionSpendUsd");
    this.maxRetries = Math.max(0, Math.floor((opts as { retries?: number }).retries ?? 2));
    this.timeoutMs = (opts as { timeoutMs?: number }).timeoutMs;
    this.fetchImpl = (opts as { fetch?: typeof fetch }).fetch;

    const ep = opts as { expectedPayTo?: string };
    if (ep.expectedPayTo !== undefined) {
      try {
        this.expectedPayTo = getAddress(ep.expectedPayTo);
      } catch {
        throw new AgentScoutError("expectedPayTo must be a valid 0x address", "invalid_config", 0);
      }
    }

    const hasSigner = "signer" in opts && opts.signer != null;
    const hasAccountKey = "accountKey" in opts && opts.accountKey != null;
    if (hasSigner && hasAccountKey) {
      throw new AgentScoutError(
        "provide exactly one auth shape: { signer } (wallet/x402) OR { accountKey } (ak_ bearer), not both",
        "invalid_config",
        0,
      );
    }
    if (hasSigner) {
      this.signer = (opts as { signer: Signer }).signer;
    } else if (hasAccountKey) {
      const ak = (opts as { accountKey: string }).accountKey;
      if (!isAccountKeyFormat(ak)) {
        throw new AgentScoutError(
          "accountKey must be of the form ak_<64 lowercase hex>",
          "invalid_config",
          0,
        );
      }
      this.accountKey = ak;
    } else {
      throw new AgentScoutError(
        "invalid auth config: provide one of { signer } | { accountKey }",
        "invalid_config",
        0,
      );
    }

    this.crawl = makeCrawl({
      accountKey: this.accountKey,
      assertTollBudget: (m, b) => this.assertTollBudget(m, b),
      v1: (p, q) => this.v1(p, q),
      fetchWithRetry: (u, b) => this.fetchWithRetry(u, b),
      asError: (r, f) => this.asError(r, f),
      performOp: (spec) => this.performOp(spec),
    });
  }

  protected fetchWithRetry(
    url: string,
    build: () => RequestInit | Promise<RequestInit>,
  ): Promise<Response> {
    return coreFetchWithRetry(url, build, this.maxRetries, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  protected async asError(res: Response, fallback: string): Promise<AgentScoutError> {
    return scoutErrorFromResponse(res.status, await res.text(), fallback);
  }

  /** Absolute URL for a scout route; `query` params (price-determining) ride the query string. */
  protected v1(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): { path: string; url: string } {
    const p = `${V1}${path}`;
    const u = new URL(this.endpoint + p);
    if (query)
      for (const [k, val] of Object.entries(query))
        if (val !== undefined) u.searchParams.set(k, String(val));
    return { path: p, url: u.toString() };
  }

  protected assertSpend(usd: number): void {
    if (this.maxSpendUsd !== undefined && usd > this.maxSpendUsd) {
      throw new SpendCapError(`spend $${usd} exceeds per-call cap $${this.maxSpendUsd}`);
    }
    if (
      this.maxSessionSpendUsd !== undefined &&
      this.sessionSpentUsd + usd > this.maxSessionSpendUsd
    ) {
      throw new SpendCapError(
        `spend $${usd} would exceed session cap $${this.maxSessionSpendUsd} (spent $${this.sessionSpentUsd})`,
      );
    }
  }

  protected recordSpend(usd: number): void {
    this.sessionSpentUsd += usd;
  }

  /**
   * Built-in op-price ceiling. When no explicit maxSpendUsd is set, refuse a server-quoted 402
   * price above DEFAULT_MAX_OP_USD so a spoofed/compromised challenge cannot drain the wallet in
   * the default (no-cap) config. A per-op backstop beneath the tighter authorized-ceiling check.
   */
  protected assertOpPriceCeiling(usd: number): void {
    if (this.maxSpendUsd === undefined && usd > DEFAULT_MAX_OP_USD) {
      throw new SpendCapError(
        `server-quoted op price $${usd} exceeds the built-in $${DEFAULT_MAX_OP_USD} op ceiling; ` +
          "set maxSpendUsd to allow a higher per-op charge",
      );
    }
  }

  /**
   * Wallet-mode-only toll guard, run BEFORE any request. In accountKey mode a toll budget is a
   * guaranteed server-side 402 tolls_require_x402, so fail fast client-side. When a base price is
   * known (pinnedBaseUsd), also pre-check base+toll against the spend caps.
   */
  protected assertTollBudget(maxTollUsd: number | undefined, pinnedBaseUsd: number): void {
    // Fail closed on a malformed toll BEFORE the early-return: a non-finite/negative value must
    // throw, not slip through to become a NaN authorizedCeilingUsd that voids the wallet-drain
    // guard downstream (`usd > NaN` is always false, so the client would sign any quoted amount).
    assertFiniteUsd(maxTollUsd, "maxTollUsd");
    if (maxTollUsd === undefined || maxTollUsd <= 0) return;
    if (this.accountKey) {
      throw new AgentScoutError(
        "max_toll_usd is wallet-mode only; an ak_ account-key caller cannot front real-USDC tolls",
        "tolls_require_x402",
        0,
        "use a wallet (signer) to pay publisher tolls",
      );
    }
    this.assertSpend(pinnedBaseUsd + maxTollUsd);
  }

  /**
   * Shared caller-side x402 orchestrator. Wallet mode: bare probe → on 402, spend-cap-check the
   * challenge-quoted price, sign the challenge VERBATIM (buildPaymentHeader pins expectedNetwork +
   * canonical USDC + expectedPayTo), retry with PAYMENT-SIGNATURE. Account mode: send the ak_ bearer;
   * a 402 (insufficient_credits) throws (fund out-of-band via AgentKV — the SDK has no funding path).
   */
  protected async performOp<T>(spec: {
    method: "GET" | "POST";
    path: string; // signed pathname (no query)
    url: string; // full URL incl. price-determining query params
    idempotencyKey: string;
    label: string;
    // Caller-authorized USD ceiling = pinned base price + the max_toll_usd actually sent. A 402
    // quoting more than this (beyond float slack) is refused BEFORE signing, so a lying/spoofed/
    // MITM'd server cannot inflate the amount. Undefined only for ops that never sign (none today).
    authorizedCeilingUsd?: number;
    buildRequest: (headers: Record<string, string>) => RequestInit;
    parseSuccess: (res: Response) => Promise<T>;
  }): Promise<T> {
    const { url, idempotencyKey, label } = spec;

    // ---- Account-key (bearer) mode ----
    if (this.accountKey) {
      const res = await this.fetchWithRetry(url, () =>
        spec.buildRequest({
          "Idempotency-Key": idempotencyKey,
          ...buildBearerHeaders(this.accountKey!),
        }),
      );
      if (!res.ok) throw await this.asError(res, label); // 402 insufficient_credits surfaces here (fund via AgentKV)
      return spec.parseSuccess(res);
    }

    // ---- Wallet (x402) mode ----
    // 1) Bare discovery probe.
    let res = await this.fetchWithRetry(url, () =>
      spec.buildRequest({ "Idempotency-Key": idempotencyKey }),
    );

    // 2) 402 → pay the exact quoted amount and retry once (same key ⇒ exactly-once).
    if (res.status === 402) {
      const challenge = res.headers.get("PAYMENT-REQUIRED");
      if (!challenge) {
        throw await this.asError(res, "payment required but no PAYMENT-REQUIRED challenge");
      }
      const usd = challengePriceUsd(challenge, undefined, this.network);
      // Money-safety: guards run BEFORE any signature is produced.
      // (a) Authorized-ceiling check (primary defense): refuse a server quoting more than the caller
      //     authorized (pinned base price + the max_toll_usd actually sent). Holds even in the
      //     default no-maxSpendUsd config, so a lying/spoofed/MITM'd server cannot inflate the amount.
      if (spec.authorizedCeilingUsd !== undefined) {
        // Defense in depth at the signing choke point: a non-finite ceiling (a NaN that somehow
        // reached here) is a HARD refusal, not a vacuous `usd > NaN` that always passes. Inputs are
        // validated upstream (assertFiniteUsd), so this only fires on a bug — but this is the last
        // gate before a signature, so it refuses rather than trusts.
        if (!Number.isFinite(spec.authorizedCeilingUsd)) {
          throw new SpendCapError(
            `authorized ceiling $${spec.authorizedCeilingUsd} is not a finite amount; refusing to sign`,
          );
        }
        if (usd > spec.authorizedCeilingUsd + PRICE_EPS) {
          throw new SpendCapError(
            `server quoted $${usd} but the client only authorized $${spec.authorizedCeilingUsd} ` +
              "(pinned base price + max_toll_usd); refusing to sign",
          );
        }
      } else {
        // (b) Backstop for an op that declared no authorized ceiling: refuse above the built-in
        //     op cap when no explicit maxSpendUsd is set.
        this.assertOpPriceCeiling(usd);
      }
      // (c) Explicit per-op + cumulative session caps (always).
      this.assertSpend(usd);
      const paymentSignature = await buildPaymentHeader(this.requireSigner(), challenge, {
        expectedNetwork: this.network,
        expectedPayTo: this.expectedPayTo,
        nonce: nonceFromIdempotencyKey(idempotencyKey),
      });
      res = await this.fetchWithRetry(url, () =>
        spec.buildRequest({
          "Idempotency-Key": idempotencyKey,
          "PAYMENT-SIGNATURE": paymentSignature,
        }),
      );
      if (res.ok) this.recordSpend(usd);
    }

    if (!res.ok) throw await this.asError(res, label);
    return spec.parseSuccess(res);
  }

  protected requireSigner(): Signer {
    if (!this.signer) {
      throw new AgentScoutError(
        "a wallet signer is required for this operation",
        "invalid_config",
        0,
      );
    }
    return this.signer;
  }

  /** Fetch a URL → clean markdown. Paid per fetch (x402 wallet mode) or per credit (account mode). */
  async read(url: string, opts: ReadOptions = {}): Promise<ReadResult> {
    this.assertTollBudget(opts.maxTollUsd, READ_BASE_USD);
    const { path, url: reqUrl } = this.v1("/read", { max_toll_usd: opts.maxTollUsd });
    const body: Record<string, unknown> = { url };
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.fresh) body.fresh = true;
    // Forwarded as a body field like the others. Typing the option without sending it
    // would silently no-op — the caller would ask for links and get none back.
    if (opts.links) body.links = true;
    return this.performOp<ReadResult>({
      method: "POST",
      path,
      url: reqUrl,
      idempotencyKey: freshNonce(),
      label: "read failed",
      authorizedCeilingUsd: READ_BASE_USD + (opts.maxTollUsd ?? 0),
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      parseSuccess: async (res) => JSON.parse(await res.text()) as ReadResult,
    });
  }

  /** Fetch → LLM → JSON validated against `schema` (a JSON Schema object). */
  async extract(url: string, schema: object, opts: ExtractOptions = {}): Promise<ExtractResult> {
    this.assertTollBudget(opts.maxTollUsd, EXTRACT_BASE_USD);
    const { path, url: reqUrl } = this.v1("/extract", { max_toll_usd: opts.maxTollUsd });
    const body: Record<string, unknown> = { url, schema };
    if (opts.instructions !== undefined) body.instructions = opts.instructions;
    return this.performOp<ExtractResult>({
      method: "POST",
      path,
      url: reqUrl,
      idempotencyKey: freshNonce(),
      label: "extract failed",
      authorizedCeilingUsd: EXTRACT_BASE_USD + (opts.maxTollUsd ?? 0),
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      parseSuccess: async (res) => {
        const parsed = JSON.parse(await res.text()) as ExtractResult | AsyncExtractJob;
        // A document too large for one pass comes back as 202 {job_id, status_url}
        // instead of a result. Poll it transparently so callers see ONE api: the
        // async hop is a server-side implementation detail, not something every
        // caller should have to hand-roll.
        if (isAsyncJob(parsed)) return this.awaitExtractJob(parsed, opts, url);
        return parsed;
      },
    });
  }

  /** FREE toll-price probe. Never signs, never spends. All branches are HTTP 200; prices are atomic USDC. */
  async quote(url: string): Promise<QuoteResult> {
    const { url: reqUrl } = this.v1("/quote", { url });
    const res = await this.fetchWithRetry(reqUrl, () => ({ method: "GET" }));
    if (!res.ok) throw await this.asError(res, "quote failed");
    return JSON.parse(await res.text()) as QuoteResult;
  }

  /**
   * Wait for an async extraction job and return its result.
   *
   * Polling is FREE — the status route reads orchestration state, and a client that
   * polls a slow job must never pay per poll. Payment already happened (or did not):
   * the server settles only when a schema-valid result exists, so a completed job is
   * one the caller was charged for and a failed job is one they were not.
   *
   * Backs off rather than hammering, and gives up at a bound instead of hanging —
   * the job keeps running server-side and its result stays readable at status_url,
   * so a timeout here loses patience, not the extraction.
   */
  private async awaitExtractJob(
    job: AsyncExtractJob,
    opts: ExtractOptions,
    url: string,
  ): Promise<ExtractResult> {
    const deadline = Date.now() + (opts.maxWaitMs ?? 120_000);
    let delay = 1_000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AgentScoutError(
          `extraction job ${job.job_id} did not finish within maxWaitMs; it may still complete server-side — poll ${job.status_url}`,
          "extract_job_timeout",
          0,
        );
      }
      // Never oversleep past the deadline.
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 1.5, 5_000);

      // Bound each poll by the remaining budget so a hung request can't outlive maxWaitMs, and
      // treat a thrown fetch (network error / per-poll timeout) as transient — the deadline check
      // at the top of the loop ends it — rather than rejecting extract() with a raw TypeError.
      let res: Response;
      try {
        res = await (this.fetchImpl ?? fetch)(job.status_url, {
          method: "GET",
          signal: AbortSignal.timeout(Math.max(0, deadline - Date.now())),
        });
      } catch {
        continue;
      }
      if (!res.ok) continue; // transient; the deadline bounds this
      const body = (await res.json()) as {
        status: string;
        data?: unknown;
        extraction?: ExtractionMeta;
        usage?: UsageBlock;
        toll?: TollAccounting;
        error?: { code: string; hint: string };
      };
      if (body.status === "complete") {
        // The result's url is the page that was extracted (the caller's `url`), NOT the job id.
        // Carry whatever accounting the server settled; the async status route may report only the
        // result (payment settles server-side), so the accounting block can legitimately be absent.
        const base = { url, data: body.data, extraction: body.extraction };
        if (body.toll) return { ...base, toll: body.toll };
        if (body.usage) return { ...base, usage: body.usage };
        return base;
      }
      if (body.status === "failed") {
        throw new AgentScoutError(
          body.error?.hint ?? "extraction job failed; nothing was charged",
          body.error?.code ?? "extract_failed",
          0,
        );
      }
    }
  }
}
