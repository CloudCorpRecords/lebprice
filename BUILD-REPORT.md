# BUILD-REPORT — lebprice (Lane B Batch B4)

Rebuild of `com.lebtechlb/lebtech` v1.0.0 (remote-only MCP server at
`https://lebtechlb.com/api/mcp`) as a clean-room forwarding client.

## Surface built

- Full 19-file factory set per TEMPLATE.md: `package.json`,
  `server.json`, `Dockerfile`, `tsconfig.json`, `.gitignore`,
  `package-lock.json`, `README.md` (written fresh), `LICENSE`
  (MIT, Copyright (c) 2026 Rene Turcios), `CHANGELOG.md` (single
  0.1.0 entry), `src/{index,cli,mcp,types,forward}.ts`,
  `test/forward.test.ts`, and
  `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`.
- Tools: exactly the fixture's 4 tools, in order —
  `search_products` (required: `query`), `get_product_prices`
  (required: `product`), `cheapest_in_category` (required:
  `category`), `price_history` (required: `product`) — registered via
  the MCP SDK low-level Server API
  (ListToolsRequestSchema/CallToolRequestSchema handlers). The
  explicit schema literals in `src/forward.ts` were generated
  programmatically from
  `harness/fixtures/lebtech-tools-original.json` by a generator
  script (`/tmp/laneb4-lebprice-scratch/generate_tools.py` +
  `assemble_forward.py`: parse + re-serialise), never retyped by
  hand; the generated `TOOL_DEFS` was verified deep-equal to the
  fixture's tools before the rest of the build proceeded, and the
  served tools/list is asserted deep-equal to the fixture (in
  order) by the test suite.
- Wire: streamable-HTTP JSON-RPC forwarding to the pinned upstream
  `https://lebtechlb.com/api/mcp` (initialize →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when issued, plain-JSON and SSE replies parsed).
  Upstream results pass through verbatim, including any upstream
  `isError` flag and extra result fields. The forwarding core takes
  an injectable fetch (`ForwardDeps.fetchFn`).

## Fixture conflicts

None. The spec and the fixture agree on the tool surface (4 tools,
names, titles, descriptions, inputSchemas, and required fields).
The fixture governs and was followed verbatim.

## Labelled reconstructions

- `LEBTECH_MCP_URL` env override of the pinned upstream endpoint —
  labelled reconstruction (per spec).
- Failure rendering as `lebprice error:` text results — labelled
  reconstruction (per spec).
- No Authorization header is ever sent, under any environment: the
  upstream registry record declares no headers. The forwarding code
  has no auth path at all, and the test suite asserts the absence of
  an `Authorization` header under several environments (empty env,
  env carrying key-like variables, URL-override-only env, and across
  a reused multi-call session).

## Lockfile

- Route: CLEAN Route 3 from birth — generated in the build dir with
  no `node_modules` present:
  `npm install --package-lock-only --ignore-scripts --offline`,
  then populated with `npm ci --ignore-scripts --offline`.
- Verified: parses as JSON, `name == @reneturcios/lebprice`,
  exactly **128** package entries.
- sha256: `564cc39b57a945e9530ca19ed4d83c6755f415a1d562429d091e7104f74f1a5d`

## server.json

- Name: `io.github.CloudCorpRecords/lebprice` (matches
  `package.json` `mcpName` and the Dockerfile label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/lebprice"`).
- Description: "Live electronics prices across Lebanese shops in USD: search, per-shop prices, history." — **87 characters**.
- npm entry: identifier `@reneturcios/lebprice`, carries
  `version: 0.1.0`. OCI entry: identifier
  `ghcr.io/cloudcorprecords/lebprice:0.1.0`, carries **no**
  `version` field (verified programmatically).
- `publish-container.yml`: `IMAGE: ghcr.io/cloudcorprecords/lebprice`;
  smoke test asserts the MCP server name `lebprice`.

## Verification results (this run)

- `npx tsc --noEmit` — exit 0.
- `npm run build` — exit 0 (`dist/cli.js` produced;
  `node dist/cli.js --version` prints `0.1.0`).
- `npm test` — **42 tests, 42 pass, 0 fail** (fake-fetch only;
  stubbed JSON-RPC upstream; no live network calls, no live call
  claimed). Coverage includes: registration integrity (served
  tools/list deep-equals the fixture's 4 tools in order),
  no-Authorization-header assertions under several environments,
  `LEBTECH_MCP_URL` env override and explicit URL override,
  verbatim argument forwarding for all 4 tools, result
  pass-through including upstream `isError`, SSE parsing
  (unit and end-to-end), error rendering (`lebprice error:` for
  JSON-RPC errors, initialize errors, malformed bodies, HTTP 500,
  throwing fetch, timeouts), session establishment/reuse and
  `Mcp-Session-Id` handling, MCP-layer validation, and CLI
  behaviour (`--version` prints `0.1.0`, usage errors exit 2).
- Parity: `python3 harness/parity.py --original
  harness/fixtures/lebtech-tools-original.json --rebuild
  "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/lebprice/dist/cli.js mcp"
  --out builds/lebprice/parity-out` → **verdict PASS, parity
  100.0** (4/4 tools identical, no missing, no extra, no schema
  diffs). Report in `parity-out/parity.json` / `parity.md`.
