import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentScout } from "../src/index";

const endpoint = "https://scout.example";
const signer = privateKeyToAccount(generatePrivateKey());
const AK = `ak_${"a".repeat(64)}`;

function challenge(amount: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          resource: "/v1/scout/crawl",
          description: "crawl",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

function completeBody(job_id: string, pages_ok: number, pages_failed = 0) {
  return {
    job_id,
    status: "complete",
    seed_url: "https://ex.com",
    same_origin: true,
    max_pages: 3,
    vectorize: false,
    requested_at: 1,
    completed_at: 2,
    pages_crawled: pages_ok + pages_failed,
    pages_ok,
    pages_failed,
    pages: [],
    budget: { max_pages: 3, billable_pages: pages_ok, unused_pages: 3 - pages_ok },
    tolls_paid_atomic: 0,
    unused_toll_atomic: 0,
    tolls: [],
    tolls_skipped: [],
    corpus_prefix: `corpus/${job_id}`,
    manifest_url: `https://scout.example/artifact/${job_id}/manifest.json`,
  };
}

describe("crawl", () => {
  it("submit sends max_pages as a query param and returns { jobId } from the 202 job_id", async () => {
    let n = 0;
    const urls: string[] = [];
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: (async (input: any) => {
        urls.push(typeof input === "string" ? input : input.url);
        n++;
        if (n === 1)
          return new Response("{}", {
            status: 402,
            headers: { "PAYMENT-REQUIRED": challenge("6000") },
          });
        return new Response(
          JSON.stringify({
            job_id: "job-1",
            status: "queued",
            status_url: `${endpoint}/v1/scout/crawl/job-1`,
            max_pages: 3,
            same_origin: true,
            toll_budget_atomic: 0,
          }),
          { status: 202 },
        );
      }) as unknown as typeof fetch,
    });
    const { jobId } = await client.crawl.submit("https://ex.com", { maxPages: 3 });
    expect(jobId).toBe("job-1");
    expect(urls.every((u) => u.includes("max_pages=3"))).toBe(true);
  });

  it("crawl() with a tiny timeout returns a resumable pending handle (not an error)", async () => {
    // submit returns 202; status stays 'running' → timeout elapses → pending.
    let n = 0;
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: (async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/crawl/job-2"))
          return new Response(JSON.stringify({ job_id: "job-2", status: "running" }), {
            status: 200,
          });
        n++;
        if (n === 1)
          return new Response("{}", {
            status: 402,
            headers: { "PAYMENT-REQUIRED": challenge("6000") },
          });
        return new Response(JSON.stringify({ job_id: "job-2", status: "queued" }), { status: 202 });
      }) as unknown as typeof fetch,
    });
    const outcome = await client.crawl("https://ex.com", {
      maxPages: 3,
      timeoutMs: 30,
      pollIntervalMs: 10,
    });
    expect(outcome.status).toBe("pending");
    expect(outcome.jobId).toBe("job-2");
  });

  it("wait resolves an all-pages-failed crawl to complete (pages_ok:0), never throws", async () => {
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: (async () =>
        new Response(JSON.stringify(completeBody("job-3", 0, 3)), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const outcome = await client.crawl.wait("job-3", { timeoutMs: 100, pollIntervalMs: 10 });
    expect(outcome.status).toBe("complete");
    if (outcome.status === "complete") {
      expect(outcome.pages_ok).toBe(0);
      expect(outcome.pages_failed).toBe(3);
      expect(outcome.jobId).toBe("job-3");
    }
  });

  it("wait throws on a Workflow errored status", async () => {
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: (async () =>
        new Response(JSON.stringify({ job_id: "job-4", status: "errored", error: "boom" }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(
      client.crawl.wait("job-4", { timeoutMs: 100, pollIntervalMs: 10 }),
    ).rejects.toMatchObject({ code: "crawl_errored" });
  });

  it("status maps an unknown job (404) to not_found", async () => {
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: (async () =>
        new Response(JSON.stringify({ error: "no such job", code: "not_found" }), {
          status: 404,
        })) as unknown as typeof fetch,
    });
    await expect(client.crawl.status("nope")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("artifact returns the Response body and preserves slashes in the key path", async () => {
    let seenUrl = "";
    const client = new AgentScout({
      signer,
      endpoint,
      fetch: (async (input: any) => {
        seenUrl = typeof input === "string" ? input : input.url;
        return new Response("artifact-bytes", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await client.crawl.artifact("job", "a/b/c.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("artifact-bytes"); // the body streams through untouched
    // multi-segment keys keep their slashes (each segment encoded, joined with "/")
    expect(seenUrl).toContain("/v1/scout/crawl/job/artifact/a/b/c.md");
  });

  it("account mode + maxTollUsd rejects client-side before submit", async () => {
    let requested = false;
    const client = new AgentScout({
      accountKey: AK,
      endpoint,
      fetch: (async () => {
        requested = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(
      client.crawl.submit("https://ex.com", { maxPages: 3, maxTollUsd: 0.01 }),
    ).rejects.toMatchObject({ code: "tolls_require_x402" });
    expect(requested).toBe(false);
  });
});
