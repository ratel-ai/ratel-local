# `examples/claude-with-ratel/`

Run a Claude Code session where the **only** MCP server is `ratel-mcp`, and `ratel-mcp` itself fronts one or more upstream MCPs behind its `search_tools` + `invoke_tool` gateway. The session sees two tools instead of N — even though everything in the upstream catalogs remains reachable through `ratel-mcp`.

This is the headline demo: drop-in replacement for a multi-MCP setup.

## What's in here

```
ratel-config.json                  # ratel-mcp's own config — list of upstream MCPs to aggregate
claude-with-ratel.template.json    # Claude Code meta-config template (committed)
claude-with-ratel.json             # Resolved meta-config with absolute paths (gitignored, generated)
gen-config.mjs                     # Substitutes <REPO_ROOT> in the template
package.json                       # Local helper package; `start` script runs the whole flow
```

The template uses `<REPO_ROOT>` as a placeholder because Claude Code's `--mcp-config` requires absolute paths in the `args` array (Claude Code spawns the MCP server from its own cwd, so relative paths don't resolve). `gen-config` walks up from this folder to find the repo root and writes the resolved file.

## Prerequisites

- Node 24+, pnpm 10+
- The Claude Code CLI (`claude`) on `PATH`
- One-time setup from the repo root:
  ```bash
  pnpm install
  pnpm build
  ```

## Run

```bash
cd examples/claude-with-ratel
pnpm gen-config && claude --mcp-config ./claude-with-ratel.json --strict-mcp-config
```

That:
1. Regenerates `claude-with-ratel.json` from the template (substituting your repo root).
2. Launches `claude --mcp-config ./claude-with-ratel.json --strict-mcp-config`, which **ignores all your global and project-scoped MCPs** and loads only ratel-mcp.

## What you should see

Inside the Claude Code session:

- `/mcp` lists exactly one connected server (`ratel-mcp`) with two tools.
- The tool list shows `mcp__ratel-mcp__search_tools` and `mcp__ratel-mcp__invoke_tool` — and nothing else.
- Asking Claude to do anything tool-shaped triggers a `search_tools` call (to find the right upstream tool by id) followed by an `invoke_tool` call (to run it).

Try these to verify it's working end-to-end:

| Prompt | What confirms success |
|---|---|
| `Echo the message "hello from ratel" using a tool.` | `search_tools` returns `ev__echo`; `invoke_tool` returns `Echo: hello from ratel` |
| `Add 47 and 53 using one of your tools.` | `search_tools` ranks `ev__add` first; `invoke_tool` returns `100` |
| `List what tools are available behind your search_tools gateway.` | Claude calls `search_tools` with broad queries and reports ~10 `ev__*` entries |
| `Invoke a tool called "delete_universe" through your gateway.` | `invoke_tool` returns `{ error: "unknown toolId: delete_universe..." }` and Claude reports there's no such tool |

Critical signal: every tool call you see in the UI is `mcp__ratel-mcp__*`. If you ever see `mcp__ev__*` directly, something is bypassing the gateway.

## Customize

To aggregate your own MCPs, edit `ratel-config.json`. The shape mirrors Claude Code's `mcpServers` field — for migrating your existing setup, copy the relevant entries from `~/.claude.json` here. Stdio and HTTP transports are supported; SSE and unknown types are skipped at runtime with a stderr warning. If one upstream fails to start, ratel-mcp logs it and continues — the session stays up.

For a non-isolated installation (i.e. you want ratel-mcp to take over your real Claude Code MCP setup, not a sandboxed `--mcp-config` session), use the `ratel-mcp mcp import` wizard instead of this template.

For details on the library API itself (gateway construction, result wrapping, transport boundary adaptations), see the [repo README](../../README.md).
