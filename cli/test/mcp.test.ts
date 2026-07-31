import { SpendCapError } from "@agentscout/client";
import { describe, expect, it } from "vitest";
import type { WalletIdentity } from "../src/commands/wallet";
import { buildMcpServer } from "../src/mcp";

/** Records the options each paid verb was called with, so a toll can be asserted (or its absence). */
function fakeClient(seen: Record<string, unknown> = {}) {
  return {
    quote: async () => ({ toll_price: 0, would_pay: true }),
    read: async (_url: string, o?: Record<string, unknown>) => {
      seen.read = o;
      return { url: "u", markdown: "m", tokens: 1, cache_hit: false };
    },
    extract: async (_url: string, _schema: object, o?: Record<string, unknown>) => {
      seen.extract = o;
      return { url: "u", data: {} };
    },
    crawl: Object.assign(
      async (_url: string, o?: Record<string, unknown>) => {
        seen.crawl = o;
        return { status: "complete", jobId: "j1" };
      },
      { status: async () => ({ status: "complete" }) },
    ),
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

const WALLET: WalletIdentity = {
  address: `0x${"ab".repeat(20)}`,
  source: "keystore",
  path: "/tmp/agentscout-test/wallet.json",
};

function tools(
  client: never,
  opts: { accountMode?: boolean; defaultMaxTollUsd?: number; wallet?: WalletIdentity } = {},
) {
  return (
    buildMcpServer(
      client,
      opts.accountMode ?? false,
      opts.defaultMaxTollUsd,
      opts.wallet ?? WALLET,
    ) as unknown as {
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

/** The {error, code} envelope a refusing tool returns (isError, single JSON text block). */
function parseToolError(res: unknown): { isError: boolean; error: string; code: string } {
  const r = res as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError === true, ...JSON.parse(r.content[0].text) };
}

const PAID = ["scout_read", "scout_extract", "scout_crawl"] as const;

describe("agentscout mcp tools", () => {
  it("registers the six scout tools", () => {
    expect(Object.keys(tools(fakeClient())).sort()).toEqual([
      "scout_crawl",
      "scout_crawl_status",
      "scout_extract",
      "scout_quote",
      "scout_read",
      "scout_wallet_address",
    ]);
  });

  // The full annotation set, pinned. These are the hints a host uses to decide whether to prompt a
  // human, so an untruthful one is a real bug: `destructiveHint` DEFAULTS TO TRUE per the MCP spec,
  // so omitting it on a paid fetch advertised "may perform destructive updates". `idempotentHint`
  // stays omitted (its default, false, is correct — each paid call is billed separately).
  it("every tool advertises exactly the intended annotations", () => {
    const t = tools(fakeClient());
    expect(t.scout_quote.annotations).toEqual({
      title: "Quote",
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(t.scout_read.annotations).toEqual({
      title: "Read",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(t.scout_extract.annotations).toEqual({
      title: "Extract",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(t.scout_crawl.annotations).toEqual({
      title: "Crawl",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(t.scout_crawl_status.annotations).toEqual({
      title: "Crawl status",
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(t.scout_wallet_address.annotations).toEqual({
      title: "Wallet address",
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it("a paid verb is never advertised as read-only, and never as destructive", () => {
    const t = tools(fakeClient());
    for (const name of PAID) {
      expect(t[name].annotations?.readOnlyHint).toBe(false);
      expect(t[name].annotations?.destructiveHint).toBe(false);
      // Omitted, not false: the MCP default (false) is already the truthful value.
      expect(t[name].annotations).not.toHaveProperty("idempotentHint");
    }
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

describe("scout_wallet_address", () => {
  it("reports the resolved wallet address and keystore path", async () => {
    const res = (await tools(fakeClient()).scout_wallet_address.handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text)).toEqual(WALLET);
  });

  it("never exposes key material, whatever the caller passes", async () => {
    // The tool closes over a WalletIdentity, which has no private-key field at all — pin that the
    // serialized payload carries only the address/path/source (SECURITY.md: never print a key).
    const res = (await tools(fakeClient()).scout_wallet_address.handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(Object.keys(JSON.parse(res.content[0].text)).sort()).toEqual([
      "address",
      "path",
      "source",
    ]);
    expect(res.content[0].text).not.toMatch(/privateKey|0x[0-9a-f]{64}/i);
  });

  it("reports account-key mode rather than a wallet address", async () => {
    const wallet: WalletIdentity = {
      address: null,
      source: "account-key",
      note: "no wallet in account-key mode",
    };
    const res = (await tools(fakeClient(), { wallet }).scout_wallet_address.handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text)).toEqual(wallet);
  });
});

// Regression: `_accountMode` was accepted and never used, so a configured toll default was applied
// unconditionally. In account-key mode the client throws tolls_require_x402 BEFORE issuing any
// request, so a single config field (the plugin offers `account_key` and `max_toll_usd` side by
// side) silently bricked read, extract AND crawl.
describe("publisher-toll default vs. account-key mode", () => {
  it("wallet mode: the configured default is applied to every paid verb", async () => {
    const seen: Record<string, unknown> = {};
    const t = tools(fakeClient(seen), { defaultMaxTollUsd: 0.05 });
    await t.scout_read.handler({ url: "https://ex.com" }, {});
    await t.scout_extract.handler({ url: "https://ex.com", schema: {} }, {});
    await t.scout_crawl.handler({ url: "https://ex.com", max_pages: 2 }, {});
    for (const verb of ["read", "extract", "crawl"]) {
      expect((seen[verb] as Record<string, unknown>).maxTollUsd).toBe(0.05);
    }
  });

  it("wallet mode: an explicit max_toll_usd overrides the default", async () => {
    const seen: Record<string, unknown> = {};
    const t = tools(fakeClient(seen), { defaultMaxTollUsd: 0.05 });
    await t.scout_read.handler({ url: "https://ex.com", max_toll_usd: 0.01 }, {});
    expect((seen.read as Record<string, unknown>).maxTollUsd).toBe(0.01);
  });

  it("account mode: the configured default is IGNORED, so every paid verb still runs", async () => {
    const seen: Record<string, unknown> = {};
    const t = tools(fakeClient(seen), { accountMode: true, defaultMaxTollUsd: 0.05 });
    const read = (await t.scout_read.handler({ url: "https://ex.com" }, {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const extract = (await t.scout_extract.handler({ url: "https://ex.com", schema: {} }, {})) as {
      isError?: boolean;
    };
    const crawl = (await t.scout_crawl.handler({ url: "https://ex.com", max_pages: 2 }, {})) as {
      isError?: boolean;
    };
    // All three reach the client (no client-side tolls_require_x402 throw) ...
    expect(read.isError).toBeUndefined();
    expect(extract.isError).toBeUndefined();
    expect(crawl.isError).toBeUndefined();
    expect(JSON.parse(read.content[0].text).markdown).toBe("m");
    // ... and none of them carries a toll the ak_ caller cannot front.
    for (const verb of ["read", "extract", "crawl"]) {
      expect((seen[verb] as Record<string, unknown>).maxTollUsd).toBeUndefined();
    }
  });

  it("account mode: an EXPLICIT max_toll_usd is refused with tolls_require_x402, not dropped", async () => {
    const seen: Record<string, unknown> = {};
    const t = tools(fakeClient(seen), { accountMode: true });
    for (const name of PAID) {
      const args =
        name === "scout_extract"
          ? { url: "https://ex.com", schema: {}, max_toll_usd: 0.02 }
          : { url: "https://ex.com", max_pages: 2, max_toll_usd: 0.02 };
      const err = parseToolError(await t[name].handler(args, {}));
      expect(err.isError).toBe(true);
      expect(err.code).toBe("tolls_require_x402");
    }
    // Refused BEFORE the client — no paid verb was dialed.
    expect(seen).toEqual({});
  });

  it("account mode: max_toll_usd 0 is not a budget, so it runs with no toll", async () => {
    const seen: Record<string, unknown> = {};
    const t = tools(fakeClient(seen), { accountMode: true, defaultMaxTollUsd: 0.05 });
    const res = (await t.scout_read.handler({ url: "https://ex.com", max_toll_usd: 0 }, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBeUndefined();
    expect((seen.read as Record<string, unknown>).maxTollUsd).toBeUndefined();
  });
});
