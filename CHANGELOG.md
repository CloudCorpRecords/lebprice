# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted LebTech MCP server, serving all 4 captured tools locally for tools/list and forwarding every tools/call upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when issued).
- Tools: `search_products`, `get_product_prices`, `cheapest_in_category`, `price_history`.
- Upstream results pass through verbatim; upstream failures surface as `lebprice error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). Upstream endpoint overridable via `LEBTECH_MCP_URL`; no Authorization header is ever sent, matching the upstream registry record, which declares no headers.
