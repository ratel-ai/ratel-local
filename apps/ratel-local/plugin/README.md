# Ratel Local Plugin

This plugin root is shared by Codex and Claude Code. It exposes the Ratel Local gateway and bundles skills for operating the gateway and improving the tool catalog from usage logs.

## Layout

```text
.codex-plugin/plugin.json   # Codex plugin manifest
.claude-plugin/plugin.json  # Claude Code plugin manifest
.mcp.json                   # shared plugin MCP server definition
hooks/hooks.json            # shared plugin hook config
skills/ratel-local/           # gateway setup and debugging skill
skills/ratel-improve-tools/ # usage-log analysis skill
```

Claude Code marketplaces live at `.claude-plugin/marketplace.json`. The repo
root marketplace points at `./apps/ratel-local/plugin`, which works for both
local validation from the repo root and GitHub distribution.

Claude Code currently supports display names in plugin and marketplace metadata,
but its documented manifest schema does not include icon or logo fields. The
shared `assets/icon.svg` remains referenced by the Codex manifest.

The plugin MCP config starts the lightweight scoped connector through `npx`:

```bash
npx -y @ratel-ai/ratel-local@0.6.0-rc.0 connect
```

The connector forwards the agent's resolved project root to the authenticated
loopback daemon. The daemon loads `~/.ratel/config.json` plus that project's
`.ratel/config.json` and `.ratel/config.local.json`, sharing upstream
connections only between sessions in the same canonical project.

Set up the persistent login service once on macOS or Linux:

```bash
npx -y @ratel-ai/ratel-local@0.6.0-rc.0 setup
```

Re-running setup is safe: it starts a stopped service and offers to replace a
service from an incompatible Ratel version.

If the daemon is missing or stopped, the connector still starts and exposes
status, start, and setup-guidance MCP tools. The setup tool returns the terminal
command above; it never launches interactive prompts on MCP stdio.

## Hooks

The plugin includes passive logging hooks for `PreToolUse` and `PostToolUse`. Codex and Claude Code both use `hooks/hooks.json`, which runs `hooks/log-tool-usage.mjs`, reads the hook event JSON from stdin, and appends one compact JSON line per tool event to:

```text
${RATEL_HOME:-$HOME/.ratel}/tool-usage/tool-usage.jsonl
```

The logger bounds large values, redacts common secret-bearing fields, and does not print output or return decisions. Logging failures are ignored so hooks do not block tool calls.

Use the bundled `ratel-improve-tools` skill to summarize those logs and propose MCP catalog improvements.

## Codex Local Validation

Add the repo root as a local Codex marketplace root:

```bash
codex plugin marketplace add .
```

The repo root contains `.agents/plugins/marketplace.json`, which points Codex at
`./apps/ratel-local/plugin`. Then restart Codex, install **Ratel Local** from the
**Ratel** marketplace, and start a new thread.

## Claude Code Local Validation

From the repo root:

```bash
claude plugin validate ./apps/ratel-local/plugin
claude plugin validate .
```

Add the local repo marketplace:

```bash
claude plugin marketplace add .
claude plugin install ratel-local@ratel
```

For GitHub distribution, publish the repo and add the root marketplace:

```bash
claude plugin marketplace add ratel-ai/ratel-local
claude plugin install ratel-local@ratel
```

If Claude Code is already running, restart it or run `/reload-plugins` inside
the session.

## Configure Upstreams

Use the normal Ratel CLI:

```bash
ratel-local mcp add --scope user docs -- npx -y @upstash/context7-mcp
ratel-local mcp list
ratel-local mcp auth
```

Existing explicit config flows still work:

```bash
ratel-local serve --config ~/.ratel/config.json
```
