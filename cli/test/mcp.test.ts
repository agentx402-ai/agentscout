import { SpendCapError } from "@agentscout/client";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/mcp";

function fakeClient() {
  return {
    quote: async () => ({ toll_price: 0, would_pay: true }),
    read: async () => ({ url: "u", markdown: "m", tokens: 1, cache_hit: false }),
    extract: async () => ({ url: "u", data: {} }),
    crawl: Object.assign(async () => ({ status: "complete", jobId: "j1" }), {
      status: async () => ({ status: "complete" }),
    }),
  } as never;
}

/** A client whose paid `read` refuses (SpendCapError) — models a server-quote over maxSpendUsd. */
function refusingClient() {
  return {
    quote: async () => ({ toll_price: 0, would_pay: true }),
    read: async () => {
      throw new SpendCapError("server quoted $1 but the client only authorized $0.002");
    },
    extract: async () => ({ url: "u", data: {} }),
    crawl: Object.assign(async () => ({ status: "complete", jobId: "j1" }), {
      status: async () => ({ status: "complete" }),
    }),
  } as never;
}

function tools(client: never) {
  return (
    buildMcpServer(client, false) as unknown as {
      _registeredTools: Record<
        string,
        {
          annotations?: Record<string, unknown>;
          inputSchema: { safeParse: (v: unknown) => { success: boolean } };
          handler: (a: unknown, e: unknown) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools;
}

describe("agentscout mcp tools", () => {
  it("registers the five scout tools", () => {
    expect(Object.keys(tools(fakeClient())).sort()).toEqual([
      "scout_crawl",
      "scout_crawl_status",
      "scout_extract",
      "scout_quote",
      "scout_read",
    ]);
  });
  it("quote is read-only; paid tools are NOT read-only", () => {
    const t = tools(fakeClient());
    expect(t.scout_quote.annotations?.readOnlyHint).toBe(true);
    for (const name of ["scout_read", "scout_extract", "scout_crawl"])
      expect(t[name].annotations?.readOnlyHint).toBe(false);
  });
  it("scout_read handler calls client.read and returns text content", async () => {
    const res = (await tools(fakeClient()).scout_read.handler({ url: "https://ex.com" }, {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text).markdown).toBe("m");
  });

  it("zod input validation: scout_read rejects a non-URL `url` and accepts a real one", () => {
    const t = tools(fakeClient());
    expect(t.scout_read.inputSchema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(t.scout_read.inputSchema.safeParse({ url: 42 }).success).toBe(false);
    expect(t.scout_read.inputSchema.safeParse({ url: "https://example.com" }).success).toBe(true);
  });

  it("a paid tool surfaces the client's spend refusal (does NOT return a success envelope)", async () => {
    const t = tools(refusingClient());
    // The handler awaits client.read; a SpendCapError propagates rather than resolving to content.
    await expect(t.scout_read.handler({ url: "https://ex.com" }, {})).rejects.toBeInstanceOf(
      SpendCapError,
    );
  });
});
