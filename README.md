<div align="center">
  <h1>@ratel-ai/mcp-server</h1>
  <h4>Expose a Ratel catalog over MCP — and manage your MCP scopes from one CLI.</h4>

  <p>
    <a href="https://github.com/ratel-ai/ratel">Ratel core</a> •
    <a href="https://github.com/ratel-ai/ratel/blob/main/docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/mcp-server"><img src="https://img.shields.io/npm/v/@ratel-ai/mcp-server?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel-mcp/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel-mcp?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-ELv2-blue" alt="license" /></a>
  </p>
</div>

`@ratel-ai/mcp-server` is two things in one package:

- a **library** that takes a Ratel [`ToolCatalog`](https://github.com/ratel-ai/ratel) and exposes it as a Model Context Protocol server — the MCP client (Claude Desktop, an agent framework, an `@modelcontextprotocol/sdk` `Client`) sees `search_tools` + `invoke_tool` instead of every upstream's full tool list;
- a **CLI** (`ratel-mcp`) that drops the gateway between an MCP host (Claude Code, Cursor, ChatGPT) and an arbitrary set of upstream MCP servers — with Claude-compatible config UX, three-scope hierarchy, OAuth 2.1 / PKCE for HTTP+SSE upstreams, and a one-shot `mcp import` wizard for migrating an existing Claude Code MCP setup.

This is the inverse of `@ratel-ai/sdk`'s [`registerMcpServer`](https://github.com/ratel-ai/ratel/blob/main/src/sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog), which ingests an upstream MCP server's tools *into* a catalog. `createMcpServer` exposes a catalog *as* an MCP server.

## Install

```bash
# CLI (global install)
pnpm add -g @ratel-ai/mcp-server

# Library (in a TS/Node project)
pnpm add @ratel-ai/mcp-server @ratel-ai/sdk @modelcontextprotocol/sdk
```

Or skip the install and run the CLI on-the-fly:

```bash
npx -y @ratel-ai/mcp-server --help
```

## CLI quickstart

`ratel-mcp` mirrors `claude mcp add`'s flag layout — any invocation that works against Claude Code's CLI works here unchanged.

```bash
# Add an upstream (stdio)
ratel-mcp mcp add --scope user airtable -e API_KEY=xyz -- npx -y airtable-mcp-server

# Add an upstream (HTTP, with OAuth)
ratel-mcp mcp add --scope user stripe https://mcp.stripe.com --transport http

# List what's configured
ratel-mcp mcp list

# Import your existing Claude Code MCP setup into ratel-mcp's scopes, then point Claude at ratel-mcp
ratel-mcp mcp import

# Start the gateway over stdio (this is what Claude Code spawns after `import`)
ratel-mcp serve --config ~/.ratel/config.json
```

Run `ratel-mcp <group>` for the verbs in a group:

| Group | Verbs |
|---|---|
| `mcp` | `add`, `remove`, `list`, `get`, `edit`, `import`, `link`, `auth` |
| `backup` | `list`, `undo` |
| (top-level) | `serve`, `ui` |

### `ratel-mcp mcp add` — Claude-compatible

```
ratel-mcp mcp add [flags] <name> -- <command> [args...]      # stdio
ratel-mcp mcp add [flags] <name> <url>                       # http / sse
```

| Flag | Meaning |
|---|---|
| `--transport stdio\|http\|sse` | Force a transport. Inferred otherwise (URL → http, `--` → stdio). |
| `--scope user\|project\|local` | Which scope to write to. Defaults to `user`. |
| `--env KEY=VALUE` / `-e KEY=VALUE` | Env var for stdio entries. Repeatable. |
| `--header "Name: Value"` | HTTP header for http/sse entries. Repeatable. |
| `--client-id <id>` / `--client-secret <s>` / `--callback-port <n>` / `--oauth-scope <s>` | OAuth client config for http/sse entries. DCR is preferred — pass `--client-id` only when the upstream doesn't support it. |
| `--description <text>` | Human description of the server. Wins over the auto-fetched upstream `instructions`. |
| `--no-fetch-description` | Skip the auto-probe — no connect, no description fetch, no OAuth flow. |
| `--force` | Overwrite an existing entry of the same name in the chosen scope. |

By default, `mcp add` connects to the upstream and stores its server-level `instructions` (per the MCP spec) as the entry's `description`. For http/sse upstreams it drives the OAuth 2.1 / PKCE flow inline (browser opens, tokens persist at `~/.ratel/oauth/<name>.json`).

### Three-scope hierarchy

`ratel-mcp` mirrors Claude Code's MCP scoping with three logical configs:

| Scope | Path | Notes |
|---|---|---|
| user | `~/.ratel/config.json` | Per-user, applies everywhere. |
| project | `<root>/.ratel/config.json` | Committed alongside the repo. |
| local | `<root>/.ratel/config.local.json` | Per-user-per-project; add to your project's `.gitignore`. |

When you run `ratel-mcp serve --config a.json --config b.json --config c.json`, the configs are merged in order — last wins on `mcpServers` key collisions. The `import` wizard wires the right `--config` chain into Claude Code at each scope.

### OAuth flow

HTTP and SSE upstreams that require OAuth authorization run through `ratel-mcp`'s loopback PKCE flow. From the CLI:

1. `ratel-mcp mcp add --scope user my-upstream https://mcp.example/mcp [--client-id <id>] [--callback-port <n>] [--oauth-scope "<s>"]` — records the entry **and** drives the OAuth flow inline.
2. `ratel-mcp mcp auth my-upstream` — refresh-first. If a `refresh_token` is on disk, rotates silently (no browser). Falls back to PKCE only when refresh fails.
3. `ratel-mcp mcp auth --check` — read-only status report: tokens present, refresh availability, time-to-expiry.
4. `ratel-mcp mcp list` — shows a single-line auth column per entry: `ok` / `expired` / `needs auth` / `n/a`.

When the gateway boots, every HTTP/SSE upstream with stored tokens runs through a proactive refresh. A 401 during a live `invoke_tool` returns `{ error: "needs_auth", upstream }` so the agent can branch and call the `auth` MCP tool to recover.

### Telemetry

`ratel-mcp serve` writes one JSON line per event to `~/.ratel/telemetry/<project-slug>/<ISO-ts>-<short>.jsonl` by default — every search, invoke, gateway call, upstream MCP call, and OAuth event flows through the same JSONL ([ADR 0009](https://github.com/ratel-ai/ratel/blob/main/docs/adr/0009-trace-events-core-owned-schema.md)). Best-effort, sampleable, lossy on backpressure — query-log shaped, not oplog.

| Flag | Env | Purpose |
|---|---|---|
| `--telemetry off` | `RATEL_TELEMETRY=off` | Disable telemetry for this run. |
| `--telemetry-file <path>` | — | Override the JSONL path verbatim (no slugging). |
| — | `RATEL_TELEMETRY_DIR` | Override the default telemetry root. |

For summarizing the resulting JSONL stream, see [`@ratel-ai/cli`'s `ratel inspect`](https://github.com/ratel-ai/ratel/tree/main/src/integrations/cli) — it shares the on-disk format.

### Backups & undo

Every `import`, `link`, `add`, `edit`, and `remove` snapshots the files it touches into `~/.ratel/backups/<ISO>/` with a `manifest.json`. `ratel-mcp backup list` shows what's available; `ratel-mcp backup undo` restores the most recent set.

### Browser UI

```bash
ratel-mcp ui              # starts a local UI on an ephemeral 127.0.0.1 port, opens your browser
ratel-mcp ui --port 5731  # bind a specific port
ratel-mcp ui --no-open    # print the URL without launching a browser
```

The UI mirrors the CLI verbs across all three scopes: view/add/edit/remove servers, drive OAuth, import/link from Claude Code, and undo the latest backup. The server binds to `127.0.0.1` only and gates every request on a single-use session token printed in the launch URL. Stop it with `Ctrl-C`.

## Library quickstart

```ts
import { ToolCatalog } from "@ratel-ai/sdk";
import { createMcpServer } from "@ratel-ai/mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const catalog = new ToolCatalog();
catalog.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  outputSchema: { type: "object", properties: { contents: { type: "string" } } },
  execute: async ({ path }) => ({ contents: await fs.readFile(path, "utf8") }),
});

const handle = await createMcpServer(catalog, {
  name: "my-gateway",
  version: "0.1.0",
  transport: new StdioServerTransport(),
});

// later, on shutdown:
await handle.close();
```

The MCP client connected to the other end will see exactly two tools: `search_tools` and `invoke_tool`. The catalog's tools are reachable through `invoke_tool`, never listed directly — that's the whole point (see [ADR 0003 in `ratel-ai/ratel`](https://github.com/ratel-ai/ratel/blob/main/docs/adr/0003-tool-selection-replace-vs-suggest.md)).

### `buildGatewayFromConfig`

Higher-level entrypoint that takes a parsed Ratel config (an `mcpServers` map mirroring Claude Code's shape) and spins up an upstream MCP `Client` per entry, registers each upstream's tools into a fresh catalog, and returns the catalog plus per-upstream metadata.

```ts
import { buildGatewayFromConfig, parseConfig } from "@ratel-ai/mcp-server";

const config = parseConfig(JSON.parse(await fs.readFile("./ratel-config.json", "utf8")));
const gateway = await buildGatewayFromConfig(config, {
  logger: (m) => console.error(m),
});

// gateway.catalog       -> ToolCatalog with every upstream tool registered
// gateway.upstreamServers -> [{ name, description?, toolCount }] for the search-tools description block
// await gateway.close() -> tears down every upstream client
```

If any single upstream fails to start, `buildGatewayFromConfig` logs the failure and the rest still register — the gateway stays available. The handle exposes `runAuthFlow()` (refresh-first; PKCE fallback) for HTTP/SSE upstreams marked `needsAuth`, and `setListChangedNotifier()` so the MCP server can re-list after a successful flow.

## Config shape

The config mirrors Claude Code's `.claude.json` `mcpServers` shape:

```json
{
  "mcpServers": {
    "ev": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "description": "filesystem & shell utilities"
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xyz" }
    }
  }
}
```

`type` defaults to `"stdio"` when absent. `description` is optional metadata — used to seed the agent's awareness of each upstream via `search_tools`'s description, never sent over the upstream transport. `stdio` and `http` are wired up by `defaultTransportFactory`; `sse` and unknown types are accepted by `parseConfig` but skipped at runtime by the default factory (provide your own factory for sse).

## Result wrapping

Every `tools/call` response carries the gateway's return value as a JSON-serialized text block; plain-object returns are also surfaced as `structuredContent`:

```json
{
  "content": [{ "type": "text", "text": "{\"foo\":1}" }],
  "structuredContent": { "foo": 1 }
}
```

Arrays (e.g. the hits returned by `search_tools`) only travel in `content[0].text`, since MCP requires `structuredContent` to be a JSON object.

When `invoke_tool` drives a tool that was itself registered via `registerMcpServer`, the upstream's MCP-shaped result (`{ content, structuredContent }`) is nested inside our `structuredContent` one level deeper.

`invokeToolTool`'s wrapped error payload (`{ error: "..." }` for unknown ids or executor throws) flows through as an ordinary structured result rather than an MCP `isError: true` — clients can branch on the field.

## Examples

- [`examples/claude-with-ratel/`](examples/claude-with-ratel/README.md) — Claude Code session fronted by `ratel-mcp` as the only MCP server.

## Build & test

```bash
pnpm install
pnpm build        # tsc → dist/
pnpm typecheck
pnpm lint         # biome
pnpm test         # vitest
```

CI runs all of the above on every PR.

## License

**Elastic License 2.0**, with a grant making it free for OSI-approved open-source projects. Non-OSS / commercial production use requires a commercial license. See [LICENSE.md](LICENSE.md).

## Related

- [`@ratel-ai/sdk`](https://github.com/ratel-ai/ratel/blob/main/src/sdk/ts/README.md) — the TypeScript SDK with `ToolCatalog`, `searchToolsTool`, `invokeToolTool`, `registerMcpServer`. Bundles `ratel-ai-core` (BM25 retrieval) via NAPI-RS.
- [`@ratel-ai/cli`](https://github.com/ratel-ai/ratel/tree/main/src/integrations/cli) — the long-term Ratel artifacts CLI (telemetry inspection today).
- [`ratel-ai/ratel`](https://github.com/ratel-ai/ratel) — overview, roadmap, ADRs, benchmark links.
