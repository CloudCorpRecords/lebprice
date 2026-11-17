import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  createClient,
  callTool,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  LebpriceClient,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream
 * implementing the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, no live call — the real
 * lebtechlb.com endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/lebtech-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"products\":[],\"count\":0}" }],
  structuredContent: { count: 0 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "lebtech", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new LebpriceClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function assertNoAuthorization(calls: Captured[]): void {
  for (const call of calls) {
    const keys = Object.keys(call.headers).map((k) => k.toLowerCase());
    assert.equal(keys.includes("authorization"), false);
    assert.equal(call.headers["Authorization"], undefined);
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (full capture)", () => {
  it("serves exactly the fixture's 4 tools, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 4);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 4 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "search_products",
      "get_product_prices",
      "cheapest_in_category",
      "price_history",
    ]);
  });

  it("carries exactly the fixture's required fields per tool", () => {
    const required = new Map(
      TOOL_DEFS.map((t) => [
        t.name,
        (t.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    assert.deepEqual(required.get("search_products"), ["query"]);
    assert.deepEqual(required.get("get_product_prices"), ["product"]);
    assert.deepEqual(required.get("cheapest_in_category"), ["category"]);
    assert.deepEqual(required.get("price_history"), ["product"]);
  });

  it("serves exactly name/title/description/inputSchema keys per tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("knows exactly the 4 captured tool names", () => {
    assert.equal(isKnownTool("search_products"), true);
    assert.equal(isKnownTool("get_product_prices"), true);
    assert.equal(isKnownTool("cheapest_in_category"), true);
    assert.equal(isKnownTool("price_history"), true);
    assert.equal(isKnownTool("not_a_tool"), false);
  });
});

/* ------------------------------------------------------------------ */

describe("served MCP tools/list (live server surface)", () => {
  async function connectPair(options: FakeOptions = {}) {
    const upstream = makeUpstream(options);
    const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "lebprice-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server, calls: upstream.calls };
  }

  it("serves tools/list deep-equal to the fixture's 4 tools, in order", async (t) => {
    if (skipWithoutFixture(t)) return;
    const { client, server } = await connectPair();
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools, fixture.tools);
      assert.deepEqual(
        listed.tools.map((t) => t.name),
        ["search_products", "get_product_prices", "cheapest_in_category", "price_history"],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a tools/call for an unknown tool at the MCP layer, with no upstream hop", async () => {
    const { client, server, calls } = await connectPair();
    try {
      await assert.rejects(
        () =>
          client.callTool({
            name: "not_a_tool",
            arguments: {},
          }),
        (err: unknown) => err instanceof McpError,
      );
      assert.equal(calls.length, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards a tools/call through the MCP layer and returns it verbatim", async () => {
    const { client, server, calls } = await connectPair();
    try {
      const out = await client.callTool({
        name: "search_products",
        arguments: { query: "iphone 17 256gb" },
      });
      assert.deepEqual(out, SAMPLE_RESULT);
      const params = calls[2].body.params as Record<string, unknown>;
      assert.equal(params.name, "search_products");
      assert.deepEqual(params.arguments, { query: "iphone 17 256gb" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool("search_products", { query: "macbook air m4" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://lebtechlb.com/api/mcp");

    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, {
      name: "lebprice",
      version: VERSION,
    });
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(
        call.headers["Accept"],
        "application/json, text/event-stream",
      );
    }
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("search_products", { query: "macbook air m4" });
    await c.callTool("price_history", { product: "example-id" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool("cheapest_in_category", { category: "phone" });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LEBTECH_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new LebpriceClient({
      fetchFn: upstream.fetchFn,
      env: { LEBTECH_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool("cheapest_in_category", { category: "phone" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool("cheapest_in_category", { category: "phone" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("no Authorization header is ever sent", () => {
  it("sends no Authorization header with an empty environment", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("search_products", { query: "rtx 5070 laptop" });
    assert.equal(calls.length, 3);
    assertNoAuthorization(calls);
  });

  it("sends no Authorization header when unrelated key-like env vars are set", async () => {
    const upstream = makeUpstream();
    const c = new LebpriceClient({
      fetchFn: upstream.fetchFn,
      env: {
        LEBTECH_API_KEY: "should-never-be-sent",
        API_KEY: "also-never-sent",
        AUTHORIZATION: "Bearer should-never-be-sent",
      },
    });
    await c.callTool("search_products", { query: "rtx 5070 laptop" });
    assert.equal(upstream.calls.length, 3);
    assertNoAuthorization(upstream.calls);
  });

  it("sends no Authorization header when only the URL override is set", async () => {
    const upstream = makeUpstream();
    const c = new LebpriceClient({
      fetchFn: upstream.fetchFn,
      env: { LEBTECH_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool("get_product_prices", { product: "example-id" });
    assertNoAuthorization(upstream.calls);
  });

  it("sends no Authorization header across a reused multi-call session", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("search_products", { query: "iphone 17 256gb" });
    await c.callTool("price_history", { product: "example-id" });
    assert.equal(calls.length, 4);
    assertNoAuthorization(calls);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards search_products arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      query: "macbook air m4",
      category: "laptop",
      max_price_usd: 1500,
      limit: 5,
    };
    await c.callTool("search_products", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "search_products");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards get_product_prices with its required product", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("get_product_prices", {
      product: "https://lebtechlb.com/product/example",
    });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "get_product_prices");
    assert.deepEqual(params.arguments, {
      product: "https://lebtechlb.com/product/example",
    });
  });

  it("forwards cheapest_in_category arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { category: "laptop", max_price_usd: 900, brand: "Lenovo", limit: 3 };
    await c.callTool("cheapest_in_category", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "cheapest_in_category");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards price_history with its required product", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("price_history", { product: "example-id" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "price_history");
    assert.deepEqual(params.arguments, { product: "example-id" });
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool("search_products", { query: "macbook air m4" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "product not found" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("get_product_prices", { product: "missing" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool("cheapest_in_category", { category: "tv" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "price_history",
      { product: "example-id" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "price_history");
    assert.deepEqual(params.arguments, { product: "example-id" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as lebprice error text", () => {
  it("maps a JSON-RPC error to `lebprice error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "product not priced" },
    });
    const out = await c.callTool("get_product_prices", { product: "missing" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lebprice error: product not priced");
  });

  it("maps an initialize JSON-RPC error to lebprice error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool("search_products", { query: "x" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lebprice error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool("search_products", { query: "x" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lebprice error: malformed response");
  });

  it("maps a non-2xx upstream status to lebprice error text", async () => {
    const { client: c } = stubClient({
      callBodyText: "internal error",
      callStatus: 500,
    });
    const out = await c.callTool("search_products", { query: "x" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lebprice error: HTTP 500");
  });

  it("maps a throwing fetch to lebprice error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool("search_products", { query: "x" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^lebprice error: /);
  });

  it("maps a throwing initialize fetch to lebprice error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool("search_products", { query: "x" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lebprice error: socket hang up");
  });

  it("maps a timed-out call to lebprice error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool("search_products", { query: "x" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^lebprice error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects non-object arguments before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "search_products", ["nope"]),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "cheapest_in_category", {
      category: "laptop",
      brand: "Apple",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { category: "laptop", brand: "Apple" });
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli(["search_products", "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli(["search_products", "[]"]);
    assert.equal(res.status, 2);
  });
});
