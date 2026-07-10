<div align="center">
  <h1>Ratel Local</h1>
  <h4>Local MCP gateway and management CLI, published as @ratel-ai/ratel-local.</h4>

  <p>
    <a href="https://github.com/ratel-ai/ratel">Ratel core</a> •
    <a href="https://github.com/ratel-ai/ratel/blob/main/docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/ratel-local"><img src="https://img.shields.io/npm/v/@ratel-ai/ratel-local?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel-local/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel-local?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  </p>
</div>

Ratel Local ships as `@ratel-ai/ratel-local` and is two things in one package:

- a **library** that takes a Ratel [`ToolCatalog`](https://github.com/ratel-ai/ratel) and exposes it as a Model Context Protocol server — the MCP client (Claude Desktop, an agent framework, an `@modelcontextprotocol/sdk` `Client`) sees `search_capabilities` + `invoke_tool` (plus `get_skill_content` when skills are configured) instead of every upstream's full tool list;
- a **CLI** (`ratel-local`) that drops the gateway between an MCP host (Claude Code, Cursor, ChatGPT) and an arbitrary set of upstream MCP servers — with a persistent scoped daemon, an interactive `setup` wizard, Claude-compatible config UX, three-scope hierarchy, OAuth 2.1 / PKCE for HTTP+SSE upstreams, and a one-shot `import` wizard for migrating an existing agent's MCP setup and skills.

This is the inverse of `@ratel-ai/sdk`'s [`registerMcpServer`](https://github.com/ratel-ai/ratel/blob/main/src/sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog), which ingests an upstream MCP server's tools *into* a catalog. `createMcpServer` exposes a catalog *as* an MCP server.

## Install

```bash
# CLI (global install)
pnpm add -g @ratel-ai/ratel-local

# Library (in a TS/Node project)
pnpm add @ratel-ai/ratel-local @ratel-ai/sdk @modelcontextprotocol/sdk
```

Or skip the install and run the CLI on-the-fly:

```bash
npx -y @ratel-ai/ratel-local --help
```

### Agent plugin marketplaces

The repo also ships a shared Ratel Local plugin for Codex and Claude Code. It
starts the lightweight scoped connector with `npx -y
@ratel-ai/ratel-local@0.5.0-rc.0 connect` and bundles skills for setup, debugging,
and tool-usage review. Run the daemon setup wizard once from a terminal:

```bash
npx -y @ratel-ai/ratel-local@0.5.0-rc.0 setup
```

Until setup is complete, the connector remains a valid MCP server and exposes
status, start, and setup-guidance tools instead of failing plugin startup.

#### Codex

Add the remote marketplace, then install **Ratel Local** from the **Ratel**
marketplace in Codex:

```bash
codex plugin marketplace add ratel-ai/ratel-local
```

For Codex local development from a checkout, run this from the repo root:

```bash
codex plugin marketplace add .
```

#### Claude Code

Add the remote marketplace and install the plugin:

```bash
claude plugin marketplace add ratel-ai/ratel-local
claude plugin install ratel-local@ratel
```

If Claude Code is already running, restart it or run `/reload-plugins` inside
the session.

For Claude Code local development from a checkout, use `.` as the marketplace:

```bash
claude plugin marketplace add .
claude plugin install ratel-local@ratel
```

Claude Code plugins cannot currently set a top-level `statusLine` default, so
`ratel-local link` and `ratel-local import` install the Ratel statusline
automatically after wiring up Claude Code (skipped if you already have a
non-Ratel statusline configured). Install or reinstall it manually with
`ratel-local statusline install` or from the Claude Code agent page in
`ratel-local ui`. See Claude's [statusline docs](https://code.claude.com/docs/en/statusline)
and [plugin reference](https://code.claude.com/docs/en/plugins-reference).

## CLI quickstart

`ratel-local` mirrors `claude mcp add`'s flag layout — any invocation that works against Claude Code's CLI works here unchanged.

```bash
# Add an upstream (stdio)
ratel-local mcp add --scope user airtable -e API_KEY=xyz -- npx -y airtable-mcp-server

# Add an upstream (HTTP, with OAuth)
ratel-local mcp add --scope user stripe https://mcp.stripe.com --transport http

# List what's configured
ratel-local mcp list

# Import your existing agent MCP setup into Ratel Local's scopes
ratel-local import
ratel-local import --agent codex

# Point an agent at the Ratel gateway without removing native MCP entries
ratel-local link
ratel-local link --agent claude-code

# Install the Claude Code statusline
ratel-local statusline install

# Start the gateway over stdio (this is what linked agents spawn)
ratel-local serve --config ~/.ratel/config.json

# Install or start the stable local daemon on macOS or Linux
ratel-local setup

# Bridge one agent session to the daemon using the current project scope
ratel-local connect
```

Run `ratel-local <group>` for the verbs in a group:

| Group | Verbs |
|---|---|
| `mcp` | `add`, `remove`, `list`, `get`, `edit`, `auth` |
| `backup` | `list` |
| `statusline` | render from stdin, `install`, `uninstall` |
| `daemon` | `run`, `install`, `uninstall`, `status`, `start`, `stop`, `restart` |
| (top-level) | `setup`, `import`, `link`, `serve`, `connect`, `ui` |

### `ratel-local mcp add` — Claude-compatible

```
ratel-local mcp add [flags] <name> -- <command> [args...]      # stdio
ratel-local mcp add [flags] <name> <url>                       # http / sse
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

`ratel-local` mirrors Claude Code's MCP scoping with three logical configs:

| Scope | Path | Notes |
|---|---|---|
| user | `~/.ratel/config.json` | Per-user, applies everywhere. |
| project | `<root>/.ratel/config.json` | Committed alongside the repo. |
| local | `<root>/.ratel/config.local.json` | Per-user-per-project; add to your project's `.gitignore`. |

When you run `ratel-local serve --config a.json --config b.json --config c.json`, the configs are merged in order — last wins on `mcpServers` key collisions. The `link` command wires the right `--config` chain into Claude Code at each scope. The `import` wizard migrates selected native MCP entries into Ratel and can clean those imported entries out of the agent config as its second stage.

### Claude Code statusline

`ratel-local statusline` is a Claude Code statusline command. Claude passes a
JSON payload on stdin; the command writes two statusline rows to stdout and
fails open with a loading/no-telemetry line if the payload or telemetry is
missing.

```bash
ratel-local statusline install          # write ~/.claude/settings.json
ratel-local statusline install --force  # replace another configured statusLine
ratel-local statusline uninstall        # remove only a Ratel-owned statusLine
```

Install writes a user-scoped Claude Code setting:

```json
{
  "statusLine": {
    "type": "command",
    "command": "ratel-local statusline",
    "padding": 0,
    "refreshInterval": 30
  }
}
```

The statusline reports Ratel as enabled when Claude Code is configured to start
Ratel through a linked MCP entry or an enabled `ratel-local@...` plugin. It does
not install or enable the plugin itself.

### OAuth flow

HTTP and SSE upstreams that require OAuth authorization run through `ratel-local`'s loopback PKCE flow. From the CLI:

1. `ratel-local mcp add --scope user my-upstream https://mcp.example/mcp [--client-id <id>] [--callback-port <n>] [--oauth-scope "<s>"]` — records the entry **and** drives the OAuth flow inline.
2. `ratel-local mcp auth my-upstream` — refresh-first. If a `refresh_token` is on disk, rotates silently (no browser). Falls back to PKCE only when refresh fails.
3. `ratel-local mcp auth --check` — read-only status report: tokens present, refresh availability, time-to-expiry.
4. `ratel-local mcp list` — shows a single-line auth column per entry: `ok` / `expired` / `needs auth` / `n/a`.

When the gateway boots, every HTTP/SSE upstream with stored tokens runs through a proactive refresh. A 401 during a live `invoke_tool` returns `{ error: "needs_auth", upstream }` so the agent can branch and call the `auth` MCP tool to recover.

### Telemetry

`ratel-local serve` writes one JSON line per event to `~/.ratel/telemetry/<project-slug>/<ISO-ts>-<short>.jsonl` by default — every search, invoke, gateway call, upstream MCP call, OAuth event, and Ratel's upstream tool-payload token estimate flows through the same JSONL ([ADR 0009](https://github.com/ratel-ai/ratel/blob/main/docs/adr/0009-trace-events-core-owned-schema.md)). Best-effort, sampleable, lossy on backpressure — query-log shaped, not oplog.

| Flag | Env | Purpose |
|---|---|---|
| `--telemetry off` | `RATEL_TELEMETRY=off` | Disable telemetry for this run. |
| `--telemetry-file <path>` | — | Override the JSONL path verbatim (no slugging). |
| — | `RATEL_TELEMETRY_DIR` | Override the default telemetry root. |

For summarizing the resulting JSONL stream, see [`@ratel-ai/cli`'s `ratel inspect`](https://github.com/ratel-ai/ratel/tree/main/src/integrations/cli) — it shares the on-disk format.

### Backups

Every `import`, `link`, `add`, `edit`, and `remove` snapshots the files it touches into `~/.ratel/backups/<ISO>/` with a `manifest.json`. `ratel-local backup list` shows what's available.

### Local daemon

The recommended entry point is the idempotent setup wizard:

```bash
ratel-local setup
ratel-local setup --yes          # non-interactive
ratel-local setup --port 7331    # choose the service port on first install
```

It reports success if the matching daemon is already running, starts an
installed but stopped service, replaces an incompatible daemon version, or asks
before installing a missing login service. When launched through `npx`, the
service records the stable Node/npm runner plus the pinned Ratel package version
instead of an ephemeral npm-cache script. MCP import and agent linking remain
separate `ratel-local import` and `ratel-local link` workflows.

`ratel-local daemon run` starts the same gateway over loopback HTTP with a stable
default endpoint:

```text
UI:  http://127.0.0.1:5731
MCP: http://127.0.0.1:5731/mcp
```

On macOS, `ratel-local daemon install` writes a user LaunchAgent at
`~/Library/LaunchAgents/ai.ratel.local.daemon.plist`. On Linux, it writes a
user-level systemd unit at
`~/.config/systemd/user/ratel-local-daemon.service` and runs
`systemctl --user enable --now ratel-local-daemon.service`.

Both variants start at login, store advisory runtime state in
`~/.ratel/daemon.json`, and log to `~/.ratel/logs/daemon.log` and
`~/.ratel/logs/daemon.err.log`.

```bash
ratel-local daemon install
ratel-local daemon status
ratel-local daemon restart
ratel-local daemon uninstall
```

The daemon exposes unauthenticated loopback-only health endpoints at `/healthz`
and `/api/daemon/status`. MCP requests require the private token stored at
`~/.ratel/daemon-token`; UI APIs remain protected by the UI session token.

### Scoped daemon connector

`ratel-local connect` is a lightweight stdio MCP server that bridges an agent
session to the persistent HTTP daemon. It inherits the agent process's working
directory and resolves the project root in this order:

1. `--project-root <path>`
2. `RATEL_PROJECT_ROOT`
3. `CLAUDE_PROJECT_DIR`
4. the connector process's current working directory

The connector sends the canonical root to the daemon over the authenticated
loopback connection. The daemon derives and merges the config chain itself:

```text
~/.ratel/config.json
<project>/.ratel/config.json
<project>/.ratel/config.local.json
```

Sessions for the same canonical project share one gateway and its upstream MCP
connections. Different projects receive isolated gateways. When no project root
is found, the connector uses user scope only. Configuration changes take effect
after reconnecting the agent session.

If the daemon is unavailable, the connector still initializes and exposes
bootstrap tools for status, starting an installed daemon, and setup guidance.
The setup tool directs the user to run `npx -y
@ratel-ai/ratel-local@0.5.0-rc.0 setup` in a terminal; interactive prompts never
share MCP stdout. This keeps host MCP errors actionable and protocol-safe.

### Browser UI

```bash
ratel-local ui              # starts a local UI on an ephemeral 127.0.0.1 port, opens your browser
ratel-local ui --port 5731  # bind a specific port
ratel-local ui --no-open    # print the URL without launching a browser
```

The UI mirrors the CLI verbs across all three scopes: view/add/edit/remove servers, drive OAuth, import/link from Claude Code, and inspect backups. The server binds to `127.0.0.1` only and gates every request on a single-use session token printed in the launch URL. Stop it with `Ctrl-C`.

## Library quickstart

```ts
import { ToolCatalog } from "@ratel-ai/sdk";
import { createMcpServer } from "@ratel-ai/ratel-local";
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

The MCP client connected to the other end will see `search_capabilities` and `invoke_tool` (and `get_skill_content` when skills are present). `search_capabilities` returns a `tools` bucket and a `skills` bucket. For backward compatibility the server also advertises the deprecated `search_tools` (its pre-0.2.0 tools-only result), so clients pinned to that name keep working; new clients should use `search_capabilities`. The catalog's tools are reachable through `invoke_tool`, never listed directly — that's the whole point (see [ADR 0003 in `ratel-ai/ratel`](https://github.com/ratel-ai/ratel/blob/main/docs/adr/0003-tool-selection-replace-vs-suggest.md)).

### `buildGatewayFromConfig`

Higher-level entrypoint that takes a parsed Ratel config (an `mcpServers` map mirroring Claude Code's shape) and spins up an upstream MCP `Client` per entry, registers each upstream's tools into a fresh catalog, and returns the catalog plus per-upstream metadata.

```ts
import { buildGatewayFromConfig, parseConfig } from "@ratel-ai/ratel-local";

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

`type` defaults to `"stdio"` when absent. `description` is optional metadata — used to seed the agent's awareness of each upstream via `search_capabilities`'s description, never sent over the upstream transport. `stdio` and `http` are wired up by `defaultTransportFactory`; `sse` and unknown types are accepted by `parseConfig` but skipped at runtime by the default factory (provide your own factory for sse).

## Result wrapping

Every `tools/call` response carries the gateway's return value as a JSON-serialized text block; plain-object returns are also surfaced as `structuredContent`:

```json
{
  "content": [{ "type": "text", "text": "{\"foo\":1}" }],
  "structuredContent": { "foo": 1 }
}
```

Arrays (e.g. the tool hits returned by `search_capabilities`) only travel in `content[0].text`, since MCP requires `structuredContent` to be a JSON object.

When `invoke_tool` drives a tool that was itself registered via `registerMcpServer`, the upstream's MCP-shaped result (`{ content, structuredContent }`) is nested inside our `structuredContent` one level deeper.

`invoke_tool`'s and `get_skill_content`'s error payloads (`{ error: "...", isError: true }` for unknown ids, bad args, or executor throws) are promoted to an MCP `isError: true` result by the server, so the host and model can tell a failed call from real content — the `error` field still carries the reason.

## Examples

- [`examples/claude-with-ratel/`](examples/claude-with-ratel/README.md) — Claude Code session fronted by `ratel-local` as the only MCP server.

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

**MIT**. Free to use, modify, and redistribute. See [LICENSE.md](LICENSE.md).

## Related

- [`@ratel-ai/sdk`](https://github.com/ratel-ai/ratel/blob/main/src/sdk/ts/README.md) — the TypeScript SDK with `ToolCatalog`, `searchCapabilitiesTool`, `invokeToolTool`, `registerMcpServer`. Bundles `ratel-ai-core` (BM25 retrieval) via NAPI-RS.
- [`@ratel-ai/cli`](https://github.com/ratel-ai/ratel/tree/main/src/integrations/cli) — the long-term Ratel artifacts CLI (telemetry inspection today).
- [`ratel-ai/ratel`](https://github.com/ratel-ai/ratel) — overview, roadmap, ADRs, benchmark links.
