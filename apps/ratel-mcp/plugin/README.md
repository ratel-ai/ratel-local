# Ratel MCP Plugin

This plugin root is shared by Codex and Claude Code. It exposes the Ratel MCP gateway and bundles skills for operating the gateway and improving the tool catalog from usage logs.

## Layout

```text
.codex-plugin/plugin.json   # Codex plugin manifest
.claude-plugin/plugin.json  # Claude Code plugin manifest
.mcp.json                   # shared plugin MCP server definition
hooks/hooks.json            # shared plugin hook config
skills/ratel-mcp/           # gateway setup and debugging skill
skills/ratel-improve-tools/ # usage-log analysis skill
```

Claude Code marketplaces live at `.claude-plugin/marketplace.json`. The repo
root marketplace points at `./apps/ratel-mcp/plugin`, which works for both
local validation from the repo root and GitHub distribution.

Claude Code currently supports display names in plugin and marketplace metadata,
but its documented manifest schema does not include icon or logo fields. The
shared `assets/icon.svg` remains referenced by the Codex manifest.

The plugin MCP config starts Ratel over stdio through `npx`:

```bash
npx -y @ratel-ai/mcp-server@latest serve --auto-config
```

`--auto-config` loads `~/.ratel/config.json` plus project and local Ratel configs when a project root is discoverable.

## Hooks

The plugin includes passive logging hooks for `PreToolUse` and `PostToolUse`. Codex and Claude Code both use `hooks/hooks.json`, which runs `hooks/log-tool-usage.mjs`, reads the hook event JSON from stdin, and appends one compact JSON line per tool event to:

```text
${RATEL_HOME:-$HOME/.ratel}/tool-usage/tool-usage.jsonl
```

The logger bounds large values, redacts common secret-bearing fields, and does not print output or return decisions. Logging failures are ignored so hooks do not block tool calls.

Use the bundled `ratel-improve-tools` skill to summarize those logs and propose MCP catalog improvements.

### Chat capture (intents)

The plugin also wires `UserPromptSubmit` and `Stop` hooks to `hooks/capture-chat.mjs`, which records chat turns (and, on `Stop`, backfills assistant turns from the transcript) to:

```text
${RATEL_HOME:-$HOME/.ratel}/chat/<host>/<sessionId>.jsonl
```

Like the tool-usage logger, it is passive, fail-soft, and redacts obvious secrets. The Ratel **intent pipeline** reads this capture to extract what you keep trying to do, matches each intent against the skills Ratel manages, and surfaces the results — with an "Offer New Skills" action for gaps — in the **Intents** tab of `ratel-mcp ui`.

Run an analysis manually with `ratel-mcp intents run` (or the UI's **Run now**), or let it fire on a cadence (every N messages / on idle), all configurable from **Intents → Settings**. Intent extraction runs through a swappable HTTP extractor — a local model sidecar, a Docker+GPU box, or a remote/cloud endpoint — see [`infra/claim-extractor`](../../../infra/claim-extractor/README.md).

## Codex Local Validation

Add the repo root as a local Codex marketplace root:

```bash
codex plugin marketplace add .
```

The repo root contains `.agents/plugins/marketplace.json`, which points Codex at
`./apps/ratel-mcp/plugin`. Then restart Codex, install **Ratel MCP** from the
**Ratel** marketplace, and start a new thread.

## Claude Code Local Validation

From the repo root:

```bash
claude plugin validate ./apps/ratel-mcp/plugin
claude plugin validate .
```

Add the local repo marketplace:

```bash
claude plugin marketplace add .
claude plugin install ratel-mcp@ratel
```

For GitHub distribution, publish the repo and add the root marketplace:

```bash
claude plugin marketplace add ratel-ai/ratel-mcp
claude plugin install ratel-mcp@ratel
```

If Claude Code is already running, restart it or run `/reload-plugins` inside
the session.

## Configure Upstreams

Use the normal Ratel CLI:

```bash
ratel-mcp mcp add --scope user docs -- npx -y @upstash/context7-mcp
ratel-mcp mcp list
ratel-mcp mcp auth
```

Existing explicit config flows still work:

```bash
ratel-mcp serve --config ~/.ratel/config.json
```
