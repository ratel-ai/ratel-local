<div align="center">
  <h1>@ratel-ai/mcp-server</h1>
  <p>You've connected your agent to a dozen MCP servers. Now it reads every tool on every message. Ratel fixes that — no code changes required.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
    <a href="https://github.com/ratel-ai/ratel">Ratel core</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/mcp-server"><img src="https://img.shields.io/npm/v/@ratel-ai/mcp-server?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel-mcp/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel-mcp?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  </p>
</div>

<div align="center">
  <img src="./docs/assets/hero.webp" width="960" alt="Ratel MCP gateway" />
</div>

## Introduction

`@ratel-ai/mcp-server` does two things:

- **Gateway** — sits between your MCP host (Claude Code, Cursor, ChatGPT) and your upstream MCP servers. Your agent sees only `search_capabilities` and `invoke_tool`, never the full tool list from every upstream.
- **CLI** (`ratel-mcp`) — manages your MCP scopes from one place. Add, remove, import, link, and authenticate upstreams across user / project / local scopes.

No changes to your existing MCP servers. No code in your agent.

## Why

When you connect multiple MCP servers, your agent reads every tool from every server on every message. At 10 servers × 20 tools that is 200 tool schemas burned on each turn before the model writes a single word.

Ratel sits in front of those servers and exposes two tools instead: `search_capabilities` and `invoke_tool`. The agent searches for what it needs; Ratel retrieves the right 3–5 tools from the full catalog. The rest never enter context. Full results: [benchmark.ratel.sh](https://benchmark.ratel.sh)

## Install

**Fastest path** — migrate your existing Claude Code MCP setup in one shot, no install required:

```bash
npx -y @ratel-ai/mcp-server mcp import
```

**Plugin** (Claude Code or Codex):

```bash
# Claude Code
claude plugin marketplace add ratel-ai/ratel-mcp
claude plugin install ratel-mcp@ratel

# Codex
codex plugin marketplace add ratel-ai/ratel-mcp
```

**Library** (embed in a TS / Node project): `pnpm add @ratel-ai/mcp-server @ratel-ai/sdk` — full reference at [docs.ratel.sh](https://docs.ratel.sh)

## CLI quickstart

`ratel-mcp` mirrors `claude mcp add`'s flag layout — any invocation that works against Claude Code's CLI works here unchanged.

```bash
# Add an upstream (stdio)
ratel-mcp mcp add --scope user airtable -e API_KEY=xyz -- npx -y airtable-mcp-server

# Add an upstream (HTTP, with OAuth)
ratel-mcp mcp add --scope user stripe https://mcp.stripe.com --transport http

# List what's configured
ratel-mcp mcp list

# Import your existing Claude Code MCP setup
ratel-mcp mcp import

# Point an agent at the Ratel gateway without removing native MCP entries
ratel-mcp mcp link --agent claude-code

# Start the gateway over stdio
ratel-mcp serve --config ~/.ratel/config.json
```

| Group | Verbs |
|---|---|
| `mcp` | `add`, `remove`, `list`, `get`, `edit`, `import`, `link`, `auth` |
| `backup` | `list` |
| (top-level) | `serve`, `ui` |

### `mcp add` flags

```
ratel-mcp mcp add [flags] <name> -- <command> [args...]   # stdio
ratel-mcp mcp add [flags] <name> <url>                    # http / sse
```

| Flag | Meaning |
|---|---|
| `--transport stdio\|http\|sse` | Force a transport. Inferred otherwise. |
| `--scope user\|project\|local` | Which scope to write to. Defaults to `user`. |
| `--env KEY=VALUE` / `-e KEY=VALUE` | Env var for stdio entries. Repeatable. |
| `--header "Name: Value"` | HTTP header for http/sse entries. Repeatable. |
| `--force` | Overwrite an existing entry of the same name. |

HTTP and SSE upstreams with OAuth drive a PKCE flow inline on `mcp add` and refresh automatically at gateway boot. Full OAuth reference: [docs.ratel.sh](https://docs.ratel.sh)

### Three-scope hierarchy

| Scope | Path | Notes |
|---|---|---|
| user | `~/.ratel/config.json` | Per-user, applies everywhere. |
| project | `<root>/.ratel/config.json` | Committed alongside the repo. |
| local | `<root>/.ratel/config.local.json` | Per-user-per-project; gitignore this. |

### Browser UI

```bash
ratel-mcp ui   # opens a local UI on 127.0.0.1, no external access
```

View, add, edit, and remove servers across all three scopes. Drive OAuth and import from Claude Code without touching a config file.

## How it works

When the gateway boots, it connects to every configured upstream MCP server and registers their tools into a Ratel `ToolCatalog`. The MCP host sees two tools: `search_capabilities` and `invoke_tool`. The full upstream catalog stays out of context until the agent searches for it.

Under the hood: BM25 over each tool's name and description — deterministic, no embeddings, no inference cost on the retrieval path.

## The Ratel project

| | Repo | What it is |
|---|---|---|
| **Library** | [ratel-ai/ratel](https://github.com/ratel-ai/ratel) | The engine. Rust core + TS SDK + Python SDK. Embed it in your agent. |
| **Gateway** | [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp) (this one) | MCP proxy for Claude Code, Cursor, and ChatGPT. No code changes needed. |
| **Proof** | [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench) | The benchmark harness. Full results at [benchmark.ratel.sh](https://benchmark.ratel.sh). |

## Build & test

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [AGENTS.md](AGENTS.md) — for coding agents working in this repo

## License

MIT — see [LICENSE.md](LICENSE.md).
