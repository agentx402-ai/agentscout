import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout, AgentScoutError } from "../src/index";

const signer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const endpoint = "https://svc.test";
const STATUS_URL = "https://svc.test/v1/scout/extract/job-1";

const SCHEMA = { type: "object", properties: { a: { type: "string" } } };

/** Server that answers the extract POST with a 202 job handoff, then serves the given
 * status responses in order. */
function jobServer(statuses: Array<Record<string, unknown>>) {
  let i = 0;
  const polls: string[] = [];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({ job_id: "job-1", status: "queued", status_url: STATUS_URL }),
        { status: 202 },
      );
    }
    polls.push(url);
    return new Response(JSON.stringify(statuses[Math.min(i++, statuses.length - 1)]), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, polls: () => polls };
}

describe("extract — async job handoff is transparent to the caller", () => {
  it("polls a 202 job to completion and returns the result like a sync extract", async () => {
    // The whole point: a caller writes `await client.extract(...)` and does not care
    // that the server needed multiple passes.
    const srv = jobServer([
      { job_id: "job-1", status: "running" },
      {
        job_id: "job-1",
        status: "complete",
        data: { a: "answer" },
        extraction: {
          winning_rung: "chunked",
          chunks: 40,
          merge_conflicts: 0,
          input_truncated: false,
        },
      },
    ]);
    const c = new AgentScout({ signer, endpoint, fetch: srv.fetchImpl });

    const res = await c.extract("https://big.test/", SCHEMA, { maxWaitMs: 30_000 });

    expect(res.data).toEqual({ a: "answer" });
    expect((res.extraction as { winning_rung: string }).winning_rung).toBe("chunked");
    // It kept polling past the non-terminal state rather than returning it as a result.
    expect(srv.polls().length).toBeGreaterThanOrEqual(2);
    expect(srv.polls()[0]).toBe(STATUS_URL);
  });

  it("throws the job's OWN error on failure, and says nothing was charged", async () => {
    // Pay-on-success survives the async hop: a failed job settled nothing, and the
    // caller must be told that rather than being left to assume they paid.
    const srv = jobServer([
      {
        job_id: "job-1",
        status: "failed",
        error: { code: "extract_failed", hint: "no schema-valid result; nothing was charged" },
      },
    ]);
    const c = new AgentScout({ signer, endpoint, fetch: srv.fetchImpl });

    await expect(
      c.extract("https://big.test/", SCHEMA, { maxWaitMs: 30_000 }),
    ).rejects.toMatchObject({ code: "extract_failed" });
  });

  it("gives up at maxWaitMs, and the error points at the still-running job", async () => {
    // Losing patience must not look like losing the extraction — the job keeps going
    // server-side and its result stays readable, so the status url is the payload.
    const srv = jobServer([{ job_id: "job-1", status: "running" }]);
    const c = new AgentScout({ signer, endpoint, fetch: srv.fetchImpl });

    const err = await c
      .extract("https://big.test/", SCHEMA, { maxWaitMs: 1_200 })
      .catch((e) => e as AgentScoutError);

    expect(err).toBeInstanceOf(AgentScoutError);
    expect((err as AgentScoutError).code).toBe("extract_job_timeout");
    expect((err as AgentScoutError).message).toContain(STATUS_URL);
  });

  it("a normal 200 extract is untouched — no polling, no extra requests", async () => {
    // Regression guard for the ~90% of traffic that fits in one pass.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          url: "https://small.test/",
          data: { a: "x" },
          usage: {
            service: "scout",
            op: "extract",
            price_usd: 0.02,
            list_price_usd: 0.02,
            credits_charged: 0,
          },
          extraction: { input_truncated: false, winning_rung: "8b" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const c = new AgentScout({ signer, endpoint, fetch: fetchImpl });

    const res = await c.extract("https://small.test/", SCHEMA);
    expect(res.data).toEqual({ a: "x" });
    expect(calls).toBe(1); // one request, no status poll
  });

  it("returns the extracted page url on the async path, not the job id", async () => {
    // Regression (review finding #2): awaitExtractJob returned { url: job.job_id, ... }, so a caller
    // reading result.url got an opaque job id instead of the page they extracted.
    const srv = jobServer([
      {
        job_id: "job-1",
        status: "complete",
        data: { a: "x" },
        extraction: { input_truncated: false, winning_rung: "chunked" },
      },
    ]);
    const c = new AgentScout({ signer, endpoint, fetch: srv.fetchImpl });
    const res = await c.extract("https://big.test/article", SCHEMA, { maxWaitMs: 30_000 });
    expect(res.url).toBe("https://big.test/article");
  });

  it("a thrown fetch mid-poll is transient (retried within the deadline), not a fatal error", async () => {
    // Regression (review finding #3): the poll used a bare fetch, so a thrown fetch (network blip)
    // rejected extract() with a raw TypeError instead of being retried until the deadline.
    let n = 0;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ job_id: "job-1", status: "queued", status_url: STATUS_URL }),
          { status: 202 },
        );
      }
      n++;
      if (n === 1) throw new TypeError("network blip");
      return new Response(
        JSON.stringify({ job_id: "job-1", status: "complete", data: { a: "ok" } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const c = new AgentScout({ signer, endpoint, fetch: fetchImpl });
    const res = await c.extract("https://big.test/", SCHEMA, { maxWaitMs: 30_000 });
    expect(res.data).toEqual({ a: "ok" });
  });
});
