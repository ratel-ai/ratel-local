---
name: ratel-mcp
description: Configure, use, and debug the Ratel MCP plugin and ratel-mcp CLI. Use when working with Codex or Claude Code plugin setup, importing or linking existing MCP servers into Ratel config, adding upstream MCP servers, running auth, opening the local UI, checking version mismatches, or troubleshooting missing tools and startup failures.
---

# Ratel MCP

## Model

Ratel MCP sits between a host agent and upstream MCP servers:

```text
Codex / Claude Code -> Ratel gateway -> upstream MCP servers
```

Keep the plugin MCP definition limited to starting the Ratel gateway. Put upstream MCP definitions in Ratel config files, not in the plugin `.mcp.json`.

## Plugin Runtime

The plugin `.mcp.json` starts Ratel over stdio through `npx` with `@ratel-ai/mcp-server@latest` and `serve --auto-config`. Do not duplicate upstream MCP definitions into the plugin `.mcp.json`.

For human CLI work, install the package globally and use the `ratel-mcp` bin:

```bash
pnpm add -g @ratel-ai/mcp-server@latest
ratel-mcp --version
```

Node 20 or newer is required.

## Config Scopes

Ratel config is layered from broad to narrow:

- `user`: `~/.ratel/config.json`
- `project`: `<project>/.ratel/config.json`
- `local`: `<project>/.ratel/config.local.json`

Prefer `project` for team-shared tools, `local` for machine-specific tools or secrets, and `user` for personal tools used across projects.

`serve --auto-config` loads the user config and, when a project root is discoverable, project and local configs too. If project tools are missing inside a host, check whether the host exposed the expected working directory; set `RATEL_PROJECT_ROOT` when needed.

## CLI Map

Top-level commands:

- `ratel-mcp serve` starts the MCP gateway over stdio.
- `ratel-mcp mcp` manages upstream MCP server entries.
- `ratel-mcp backup` manages backup snapshots.
- `ratel-mcp ui` launches the local browser UI.
- `ratel-mcp statusline` renders or manages the Claude Code Ratel statusline.
- `ratel-mcp --version` or `ratel-mcp version` prints the CLI version.
- `ratel-mcp help` prints top-level usage.

`ratel-mcp mcp` verbs:

- `add` adds an upstream MCP server entry.
- `remove` removes an upstream from a Ratel scope.
- `list` lists configured upstreams across Ratel scopes.
- `get` shows one entry's resolved details.
- `edit` edits fields on an existing entry; it is interactive when no edit flags are supplied.
- `import` migrates agent MCP configs into Ratel and can rewrite the agent to use the Ratel gateway.
- `link` rewrites an agent's config to point at Ratel for entries already in Ratel scopes.
- `auth` runs OAuth for HTTP/SSE upstreams or checks stored auth state.

`ratel-mcp statusline` verbs:

- no verb renders the Claude Code statusline from stdin.
- `install` writes the user-scope Claude Code `~/.claude/settings.json` statusLine.
- `uninstall` removes only a Ratel-owned statusLine.
- `install --force` replaces another configured statusLine.

## Common Workflows

Inspect configured upstreams:

```bash
ratel-mcp mcp list
```

Run the gateway from the current project:

```bash
ratel-mcp serve --auto-config
```

Open the local UI:

```bash
ratel-mcp ui
ratel-mcp ui --port 7331 --no-open
```

Add a stdio upstream:

```bash
ratel-mcp mcp add --scope project github -- npx -y @modelcontextprotocol/server-github
```

Add a stdio upstream with local secrets:

```bash
ratel-mcp mcp add --scope local github --env GITHUB_TOKEN=... -- npx -y @modelcontextprotocol/server-github
```

Add an HTTP or SSE upstream:

```bash
ratel-mcp mcp add --scope project docs https://example.com/mcp --transport http
ratel-mcp mcp add --scope project docs https://example.com/sse --transport sse
```

Add headers to an HTTP/SSE upstream:

```bash
ratel-mcp mcp add --scope local docs https://example.com/mcp --header "Authorization: Bearer ..."
```

Import existing host MCP servers into Ratel:

```bash
ratel-mcp mcp import --agent codex
ratel-mcp mcp import --agent claude-code
```

Preview or automate an import:

```bash
ratel-mcp mcp import --agent codex --dry-run
ratel-mcp mcp import --agent codex --yes --conflict-strategy add-missing-only
```

Link a host to Ratel after entries already exist in Ratel config:

```bash
ratel-mcp mcp link --agent codex
ratel-mcp mcp link --agent claude-code
```

Install the Claude Code statusline:

```bash
ratel-mcp statusline install
ratel-mcp statusline install --force
ratel-mcp statusline uninstall
```

Claude Code plugins cannot currently set top-level `statusLine` defaults
directly; use the CLI or the Claude Code agent page in `ratel-mcp ui`. The
statusline reports Ratel as on when Claude Code starts Ratel via a linked MCP
entry or an enabled `ratel-mcp@...` plugin.

Authorize HTTP/SSE upstreams:

```bash
ratel-mcp mcp auth
ratel-mcp mcp auth <name>
ratel-mcp mcp auth --check
```

Inspect backups:

```bash
ratel-mcp backup list
```

## Debug Checklist

1. Confirm Node and `npx` are available.
2. Confirm the plugin `.mcp.json` starts `@ratel-ai/mcp-server@latest` with `serve --auto-config`.
3. Run `ratel-mcp mcp list` to verify Ratel config has upstreams.
4. Run `ratel-mcp serve --auto-config` from the relevant project to reproduce startup outside the host.
5. For HTTP/SSE upstreams, run `ratel-mcp mcp auth --check` or `ratel-mcp mcp auth <name>`.
6. In Claude Code, run `/mcp` and `/reload-plugins` after plugin changes.
7. In Codex, restart the thread after plugin install or manifest changes.

Common findings:

- Empty catalog: no Ratel configs were found or all configs have empty `mcpServers`.
- Missing project tools: the host did not expose a useful project root; set `RATEL_PROJECT_ROOT` or run from the project directory.
- First startup failure: `npx` may need network access to resolve the pinned npm package.
- Auth needed: an upstream returned 401 or 403; complete the Ratel auth flow and retry.
