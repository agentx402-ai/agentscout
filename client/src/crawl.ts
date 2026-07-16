import { AgentScoutError } from "./errors";
import { freshNonce } from "./payment";
import type { CrawlCompleteBody, CrawlOptions, CrawlOutcome, CrawlStatus } from "./types";

const CRAWL_PAGE_USD = 0.002; // per-page price (confirm vs worker); base for the request-build cap pre-check.

/** The subset of AgentScout internals crawl needs. Passed in by the class to avoid a circular import. */
export interface CrawlContext {
  accountKey?: string;
  assertTollBudget(maxTollUsd: number | undefined, pinnedBaseUsd: number): void;
  v1(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): { path: string; url: string };
  fetchWithRetry(url: string, build: () => RequestInit | Promise<RequestInit>): Promise<Response>;
  asError(res: Response, fallback: string): Promise<AgentScoutError>;
  performOp<T>(spec: {
    method: "GET" | "POST";
    path: string;
    url: string;
    idempotencyKey: string;
    label: string;
    authorizedCeilingUsd?: number;
    buildRequest: (headers: Record<string, string>) => RequestInit;
    parseSuccess: (res: Response) => Promise<T>;
  }): Promise<T>;
}

export interface Crawl {
  (url: string, opts: CrawlOptions): Promise<CrawlOutcome>;
  submit(url: string, opts: CrawlOptions): Promise<{ jobId: string }>;
  status(jobId: string): Promise<CrawlStatus>;
  artifact(jobId: string, key: string): Promise<Response>;
  wait(
    jobId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<CrawlOutcome>;
}

function requireMaxPages(opts: CrawlOptions): number {
  const n = opts.maxPages;
  if (!Number.isInteger(n) || n < 1) {
    throw new AgentScoutError(
      "crawl requires maxPages: a positive integer (it determines the x402 price)",
      "invalid_request",
      0,
    );
  }
  return n;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeCrawl(ctx: CrawlContext): Crawl {
  const submit: Crawl["submit"] = async (url, opts) => {
    const maxPages = requireMaxPages(opts);
    ctx.assertTollBudget(opts.maxTollUsd, maxPages * CRAWL_PAGE_USD);
    // Price-determining params ride the query string; the body carries non-price params.
    const { path, url: reqUrl } = ctx.v1("/crawl", {
      max_pages: maxPages,
      max_toll_usd: opts.maxTollUsd,
    });
    const body: Record<string, unknown> = { url };
    if (opts.sameOrigin !== undefined) body.same_origin = opts.sameOrigin;
    if (opts.vectorize !== undefined) body.vectorize = opts.vectorize;
    const submitted = await ctx.performOp<{ job_id: string }>({
      method: "POST",
      path,
      url: reqUrl,
      idempotencyKey: freshNonce(),
      label: "crawl submit failed",
      // Authorized ceiling = pinned per-page base (max_pages × $0.002) + the max_toll_usd sent.
      authorizedCeilingUsd: maxPages * CRAWL_PAGE_USD + (opts.maxTollUsd ?? 0),
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      parseSuccess: async (res) => JSON.parse(await res.text()) as { job_id: string },
    });
    return { jobId: submitted.job_id };
  };

  const status: Crawl["status"] = async (jobId) => {
    const { url } = ctx.v1(`/crawl/${encodeURIComponent(jobId)}`);
    const res = await ctx.fetchWithRetry(url, () => ({ method: "GET" }));
    if (!res.ok) throw await ctx.asError(res, "crawl status failed"); // 404 → not_found
    return JSON.parse(await res.text()) as CrawlStatus;
  };

  const artifact: Crawl["artifact"] = async (jobId, key) => {
    // key may contain slashes; keep them (encode each segment).
    const encKey = key.split("/").map(encodeURIComponent).join("/");
    const { url } = ctx.v1(`/crawl/${encodeURIComponent(jobId)}/artifact/${encKey}`);
    const res = await ctx.fetchWithRetry(url, () => ({ method: "GET" }));
    if (!res.ok) throw await ctx.asError(res, "crawl artifact failed");
    return res; // stream the artifact body to the caller
  };

  const wait: Crawl["wait"] = async (jobId, waitOpts = {}) => {
    const timeoutMs = waitOpts.timeoutMs ?? 120_000;
    const pollIntervalMs = waitOpts.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await status(jobId);
      if ("status" in s && s.status === "complete") {
        // `s` is the complete status body ({ status: "complete", ...manifest }); spread it and
        // add jobId. The explicit `status` would be overwritten by the spread (TS2783), so the
        // spread is the single source of `status: "complete"`.
        return { jobId, ...(s as { status: "complete" } & CrawlCompleteBody) };
      }
      if ("status" in s && s.status === "errored") {
        const err = (s as { error?: string }).error ?? "crawl errored";
        throw new AgentScoutError(`crawl ${jobId} errored: ${err}`, "crawl_errored", 0, err);
      }
      if (Date.now() + pollIntervalMs >= deadline) {
        return { status: "pending", jobId }; // resumable handle — crawl still running server-side
      }
      await sleep(pollIntervalMs);
    }
  };

  const crawl = (async (url: string, opts: CrawlOptions): Promise<CrawlOutcome> => {
    const { jobId } = await submit(url, opts);
    return wait(jobId, { timeoutMs: opts.timeoutMs, pollIntervalMs: opts.pollIntervalMs });
  }) as Crawl;

  return Object.assign(crawl, { submit, status, artifact, wait });
}
