/**
 * Lifecycle test for `agentscout mcp`: verifies the server stays alive long enough to serve
 * requests and does NOT exit immediately after connect (the "connect then die" regression).
 *
 * Spawns the built binary (`dist/cli.js mcp`) via StdioClientTransport with a dummy private key
 * so wallet mode resolves locally, and points AGENTSCOUT_ENDPOINT at a tiny in-test HTTP stub so
 * a real `scout_quote` call round-trips end to end (transport → SDK → network → tool handler)
 * without touching the live service.
 *
 * Requires the CLI to be built first (`npm run build`); CI runs build before test (see ci.yml).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

// dist/cli.js relative to the workspace root (cli/)
const CLI_PATH = join(import.meta.dirname, "..", "dist", "cli.js");
const DUMMY_KEY = `0x${"1".repeat(64)}`;

// A canned free-quote body; /quote is a GET that never signs or spends.
const QUOTE_BODY = {
  toll_price: null,
  settle_fee: null,
  total: null,
  rail: null,
  would_pay: true,
  advisory: true,
  hint: "no toll",
  ts: 1,
};

let httpServer: Server;
let endpoint: string;

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/scout/quote")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(QUOTE_BODY));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", code: "not_found" }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("MCP server lifecycle", () => {
  it("stays alive, lists the 5 scout tools, reports VERSION, and serves a live scout_quote", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentscout-mcp-"));
    const transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTSCOUT_HOME: home,
        AGENTSCOUT_ENDPOINT: endpoint,
        AGENTSCOUT_PRIVATE_KEY: DUMMY_KEY,
        AGENTSCOUT_NETWORK: "eip155:8453",
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    try {
      await client.connect(transport);

      // 1. List tools — exactly the five scout tools, with truthful names.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "scout_crawl",
        "scout_crawl_status",
        "scout_extract",
        "scout_quote",
        "scout_read",
      ]);

      // 2. The initialize handshake advertises the CLI VERSION.
      expect(client.getServerVersion()?.version).toBe(VERSION);

      // 3. A live scout_quote round-trips through the stub (GET, no spend).
      const res = await client.callTool({
        name: "scout_quote",
        arguments: { url: "https://example.com/" },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      const parsed = JSON.parse(content[0].text);
      expect(parsed.would_pay).toBe(true);
      expect(parsed.advisory).toBe(true);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000 /* generous timeout for process spawn */);

  // stdout hygiene: with NO wallet key, startMcp auto-provisions a wallet and emits the
  // "created a new wallet" notice — which MUST go to stderr, because stdout is the JSON-RPC
  // channel. A stray write to stdout corrupts the framing; the SDK transport surfaces that via
  // onerror. Assert no transport/client errors while tools still list (proving stderr, not stdout).
  it("auto-provision notice goes to stderr, not the JSON-RPC stdout channel", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentscout-prov-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTSCOUT_HOME: home, // isolate keystore -> forces a fresh auto-provision
        AGENTSCOUT_ENDPOINT: endpoint,
        AGENTSCOUT_PRIVATE_KEY: "", // empty -> unset: no wallet configured -> auto-provision fires
        AGENTSCOUT_ACCOUNT_KEY: "", // empty -> not account mode
      },
    });
    const errors: unknown[] = [];
    transport.onerror = (e) => errors.push(e);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    client.onerror = (e) => errors.push(e);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5); // handshake + listing succeeded ...
      expect(errors).toHaveLength(0); // ... with NO framing corruption from a stray stdout notice
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
