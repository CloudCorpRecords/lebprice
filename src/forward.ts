/**
 * lebprice core: a forwarding client for the hosted
 * LebTech MCP server.
 *
 * This package holds no price data and computes nothing
 * about electronics. tools/list is answered locally from
 * the literal definitions below, which reproduce a live
 * capture of the upstream server for all 4 captured tools
 * (name, title, description and inputSchema exactly as
 * captured). A tools/call is forwarded over a
 * streamable-HTTP JSON-RPC session: an initialize POST,
 * a notifications/initialized POST, then the tools/call
 * POST, honouring the Mcp-Session-Id response header
 * when the upstream issues one. The session opens lazily
 * on the first forwarded call and is reused for the rest
 * of the client's lifetime.
 *
 * The upstream endpoint is pinned to
 * https://lebtechlb.com/api/mcp and can be overridden
 * with the LEBTECH_MCP_URL environment variable (that
 * override is a labelled reconstruction). The upstream's
 * registry record declares no headers, so this client
 * never sends an Authorization header, under any
 * environment.
 *
 * Upstream results pass through verbatim, including any
 * isError flag and any extra result fields. Failures — a
 * JSON-RPC error from the upstream, a non-2xx status, an
 * unparseable response, or a fetch that throws or times
 * out — surface as an isError result whose text starts
 * with `lebprice error:` (that rendering is a labelled
 * reconstruction). Responses may be plain JSON or SSE
 * (data: lines); the JSON-RPC message with the matching
 * id wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://lebtechlb.com/api/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals for the 4 captured tools,     */
/* verbatim from the live capture in                                  */
/* harness/fixtures/lebtech-tools-original.json, generated             */
/* programmatically from the fixture — never retyped)                  */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "search_products",
    "title": "Search LebTech",
    "description": "Find electronics sold in Lebanon and their live prices across Lebanese shops (USD, re-checked nightly). Returns up to 10 products, most widely sold first, each with its lowest price, how many shops sell it, and its LebTech page. Laptops also carry model_page: every CPU/GPU variant of that model with the same RAM/storage, which can start lower.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "What to look for, e.g. 'macbook air m4', 'rtx 5070 laptop', 'iphone 17 256gb'."
        },
        "category": {
          "type": "string",
          "enum": [
            "laptop",
            "phone",
            "tablet",
            "monitor",
            "tv",
            "console",
            "audio",
            "component",
            "peripheral",
            "camera",
            "wearable",
            "appliance",
            "power",
            "networking",
            "printer",
            "storage",
            "game",
            "desktop",
            "smarthome",
            "creator",
            "print3d"
          ],
          "description": "Optional: limit to one category."
        },
        "max_price_usd": {
          "type": "number",
          "description": "Optional upper price limit in USD."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "get_product_prices",
    "title": "Prices for one product",
    "description": "Live per-shop prices for ONE product in Lebanon: every shop that has the identical configuration in stock, cheapest first, with links to the shop's own product page. Takes a LebTech product id or a lebtechlb.com /product/ or /laptop/ URL.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product": {
          "type": "string",
          "description": "A product id or a lebtechlb.com /product/ or /laptop/ URL."
        }
      },
      "required": [
        "product"
      ]
    }
  },
  {
    "name": "cheapest_in_category",
    "title": "Cheapest in a category",
    "description": "The cheapest products currently in stock in a category in Lebanon (laptops: cheapest among sensible, new machines first). Optional budget and brand. Up to 10 results.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "category": {
          "type": "string",
          "enum": [
            "laptop",
            "phone",
            "tablet",
            "monitor",
            "tv",
            "console",
            "audio",
            "component",
            "peripheral",
            "camera",
            "wearable",
            "appliance",
            "power",
            "networking",
            "printer",
            "storage",
            "game",
            "desktop",
            "smarthome",
            "creator",
            "print3d"
          ]
        },
        "max_price_usd": {
          "type": "number"
        },
        "brand": {
          "type": "string",
          "description": "Exact brand, e.g. 'Lenovo', 'Apple', 'Samsung'."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        }
      },
      "required": [
        "category"
      ]
    }
  },
  {
    "name": "price_history",
    "title": "Price history",
    "description": "How the lowest price of one product across Lebanese shops moved over the last ~90 days: current low, period low/high, the drop since tracking began, and weekly lows. Takes a LebTech product id or a lebtechlb.com /product/ or /laptop/ URL.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product": {
          "type": "string",
          "description": "A product id or a lebtechlb.com /product/ or /laptop/ URL."
        }
      },
      "required": [
        "product"
      ]
    }
  }
];

export const TOOL_NAMES: string[] = TOOL_DEFS.map((t) => t.name);

export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `lebprice error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Parse a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * one is present, else the last parseable message, else
 * null when nothing parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON; ignore this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding one upstream session. The
 * session is established lazily on the first forwarded
 * call and reused for the lifetime of the client (the
 * process lifetime when the client backs the MCP server,
 * or a single shot for the CLI).
 */
export class LebpriceClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).LEBTECH_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    // The upstream registry record declares no headers:
    // no Authorization header is ever sent here.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "lebprice", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // The notification response body carries nothing we need.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Pass the upstream result through verbatim.
    return result;
  }
}

/** Create a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): LebpriceClient {
  return new LebpriceClient(deps);
}

/** One-shot helper: a fresh client per call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new LebpriceClient(deps).callTool(name, args);
}
