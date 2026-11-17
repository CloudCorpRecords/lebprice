# lebprice

lebprice is a small local bridge to LebTech's hosted MCP
server, a price catalogue for electronics sold in Lebanon:
what a laptop, phone or television costs right now at the
Lebanese shops that stock it, quoted in USD and re-checked
nightly by the vendor.

The bridge keeps no product or price data of its own. It
serves the upstream server's tool list locally, exactly
as captured from the live endpoint, and forwards each
tool call upstream, returning the result untouched. Every
tool is a read over published prices; there is no buying,
ordering or checkout surface here.

## Tools

- `search_products` — find electronics sold in Lebanon
  with live prices across shops. Required: `query`.
  Optional: `category` (one of 21 categories, from
  `laptop` to `print3d`), `max_price_usd`, `limit`
  (1–10). Answers carry each product's lowest price, how
  many shops sell it, and its LebTech page; laptops also
  carry the model's CPU/GPU variants.
- `get_product_prices` — live per-shop prices for one
  product: every shop with the identical configuration
  in stock, cheapest first, with links to each shop's
  own product page. Required: `product` (a LebTech
  product id or a lebtechlb.com `/product/` or
  `/laptop/` URL).
- `cheapest_in_category` — the cheapest products
  currently in stock in one category. Required:
  `category`. Optional: `max_price_usd`, `brand`,
  `limit` (1–10).
- `price_history` — how one product's lowest price moved
  over the last ~90 days: current low, period low and
  high, the drop since tracking began, and weekly lows.
  Required: `product` (same id-or-URL form as above).

## Configuration

- `LEBTECH_MCP_URL` (optional) — override the upstream
  endpoint. Defaults to `https://lebtechlb.com/api/mcp`.
  (The override hook is this rebuild's own labelled
  reconstruction.)

No credentials are used. The upstream's registry record
declares no headers, so this client never sends an
`Authorization` header, whatever the environment holds.

### Forwarding mechanics

On the first tool call the client opens a streamable
HTTP session with the upstream: a JSON-RPC `initialize`
request (protocolVersion `2025-03-26`, clientInfo name
`lebprice`), then a `notifications/initialized`
notification, then the `tools/call` request carrying
the caller's arguments unchanged. When the upstream
answers `initialize` with an `Mcp-Session-Id` header,
that value rides on every later request of the session,
which is reused for the life of the process. Replies
may arrive as plain JSON or as server-sent events;
both are read.

Successful upstream results pass through verbatim,
including any `isError` flag the upstream sets.
Failures — a JSON-RPC error, a non-2xx status, an
unreadable response, or a request that cannot be
completed — come back as an `isError` result whose
text starts with `lebprice error:` (this rendering
is this rebuild's own labelled reconstruction).

## CLI

Each tool is also a subcommand taking one JSON argument
string:

```bash
npx @reneturcios/lebprice search_products '{"query":"macbook air m4"}'
npx @reneturcios/lebprice get_product_prices '{"product":"https://lebtechlb.com/product/example"}'
npx @reneturcios/lebprice cheapest_in_category '{"category":"laptop","brand":"Lenovo"}'
npx @reneturcios/lebprice price_history '{"product":"example-id"}'
npx @reneturcios/lebprice --version
```

Exit codes: `0` on success, `1` on an `isError`
result, `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/lebprice mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "lebprice": {
      "command": "npx",
      "args": ["-y", "@reneturcios/lebprice", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/lebprice
docker run --rm ghcr.io/cloudcorprecords/lebprice --version
```

The container's default command is `mcp`, so the first
form is a stdio MCP server; any other arguments reach
the CLI normally.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs entirely against a stubbed
JSON-RPC upstream — no live network calls.

## License

MIT — see `LICENSE`.
