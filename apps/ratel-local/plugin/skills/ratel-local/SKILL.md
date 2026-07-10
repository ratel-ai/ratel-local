---
name: ratel-local
description: Configure, use, and debug the Ratel Local plugin and ratel-local CLI. Use when working with Codex or Claude Code plugin setup, importing or linking existing MCP servers into Ratel config, adding upstream MCP servers, running auth, opening the local UI, checking version mismatches, or troubleshooting missing tools and startup failures.
---

# Ratel Local

## Model

Ratel Local sits between a host agent and upstream MCP servers:

```text
Codex / Claude Code -> Ratel gateway -> upstream MCP servers
```

Keep the plugin MCP definition limited to starting the Ratel gateway. Put upstream MCP definitions in Ratel config files, not in the plugin `.mcp.json`.

## Plugin Runtime

The plugin `.mcp.json` starts Ratel over stdio through `npx` with `@ratel-ai/ratel-local@latest` and `serve --auto-config`. Do not duplicate upstream MCP definitions into the plugin `.mcp.json`.

For human CLI work, install the package globally and use the `ratel-local` bin:

```bash
pnpm add -g @ratel-ai/ratel-local@latest
ratel-local --version
```

Node 20 or newer is required.

## Config Scopes

Ratel config is layered from broad to narrow:

- `user`: `~/.ratel/config.json`
- `project`: `<project>/.ratel/config.json`
- `local`: `<project>/.ratel/config.local.json`

Prefer `project` for team-shared tools, `local` for machine-specific tools or secrets, and `user` for personal tools used across projects.

`serve --auto-config` loads the user config and, when a project root is discoverable, project and local configs too. If project tools are missing inside a host, check whether the host exposed the expected working directory; set `RATEL_PROJECT_ROOT` when needed.

## Config Editing Rule

When adding, removing, or changing upstream MCP server entries, use the
`ratel-local mcp` CLI by default. Do not edit Ratel config JSON files directly
unless one of these is true:

- the user explicitly asks for a direct file edit;
- the CLI is unavailable or fails;
- the requested change cannot be expressed through the CLI.

If falling back to direct JSON edits, state why the CLI was not used, preserve
the existing config shape, and validate the JSON afterwards.

## CLI Map

Top-level commands:

- `ratel-local serve` starts the MCP gateway over stdio.
- `ratel-local mcp` manages upstream MCP server entries.
- `ratel-local backup` manages backup snapshots.
- `ratel-local ui` launches the local browser UI.
- `ratel-local statusline` renders or manages the Claude Code Ratel statusline.
- `ratel-local --version` or `ratel-local version` prints the CLI version.
- `ratel-local help` prints top-level usage.

`ratel-local mcp` verbs:

- `add` adds an upstream MCP server entry.
- `remove` removes an upstream from a Ratel scope.
- `list` lists configured upstreams across Ratel scopes.
- `get` shows one entry's resolved details.
- `edit` edits fields on an existing entry; it is interactive when no edit flags are supplied.
- `import` migrates agent MCP configs into Ratel and can rewrite the agent to use the Ratel gateway.
- `link` rewrites an agent's config to point at Ratel for entries already in Ratel scopes.
- `auth` runs OAuth for HTTP/SSE upstreams or checks stored auth state.

`ratel-local statusline` verbs:

- no verb renders the Claude Code statusline from stdin.
- `install` writes the user-scope Claude Code `~/.claude/settings.json` statusLine.
- `uninstall` removes only a Ratel-owned statusLine.
- `install --force` replaces another configured statusLine.

## Common Workflows

Inspect configured upstreams:

```bash
ratel-local mcp list
```

Run the gateway from the current project:

```bash
ratel-local serve --auto-config
```

Open the local UI:

```bash
ratel-local ui
ratel-local ui --port 7331 --no-open
```

Required workflow for adding a stdio upstream:

```bash
ratel-local mcp add --scope project github -- npx -y @modelcontextprotocol/server-github
```

Required workflow for adding a stdio upstream with local secrets:

```bash
ratel-local mcp add --scope local github --env GITHUB_TOKEN=... -- npx -y @modelcontextprotocol/server-github
```

Required workflow for adding an HTTP or SSE upstream:

```bash
ratel-local mcp add --scope project docs https://example.com/mcp --transport http
ratel-local mcp add --scope project docs https://example.com/sse --transport sse
```

Required workflow for adding headers to an HTTP/SSE upstream:

```bash
ratel-local mcp add --scope local docs https://example.com/mcp --header "Authorization: Bearer ..."
```

Import existing host MCP servers into Ratel:

```bash
ratel-local import --agent codex
ratel-local import --agent claude-code
```

Preview or automate an import:

```bash
ratel-local import --agent codex --dry-run
ratel-local import --agent codex --yes --conflict-strategy add-missing-only
```

Link a host to Ratel after entries already exist in Ratel config:

```bash
ratel-local link --agent codex
ratel-local link --agent claude-code
```

`ratel-local link` and `ratel-local import` install the Claude Code
statusline automatically once they finish wiring up Claude Code (skipped if a
non-Ratel statusline is already configured). Manage it directly with:

```bash
ratel-local statusline install
ratel-local statusline install --force
ratel-local statusline uninstall
```

Claude Code plugins cannot currently set top-level `statusLine` defaults
directly; use the CLI (directly, or automatically via `link`/`import`) or the
Claude Code agent page in `ratel-local ui`. The statusline reports Ratel as on
when Claude Code starts Ratel via a linked MCP entry or an enabled
`ratel-local@...` plugin.

Authorize HTTP/SSE upstreams:

```bash
ratel-local mcp auth
ratel-local mcp auth <name>
ratel-local mcp auth --check
```

Inspect backups:

```bash
ratel-local backup list
```

## Debug Checklist

1. Confirm Node and `npx` are available.
2. Confirm the plugin `.mcp.json` starts `@ratel-ai/ratel-local@latest` with `serve --auto-config`.
3. Run `ratel-local mcp list` to verify Ratel config has upstreams.
4. Run `ratel-local serve --auto-config` from the relevant project to reproduce startup outside the host.
5. For HTTP/SSE upstreams, run `ratel-local mcp auth --check` or `ratel-local mcp auth <name>`.
6. In Claude Code, run `/mcp` and `/reload-plugins` after plugin changes.
7. In Codex, restart the thread after plugin install or manifest changes.

Common findings:

- Empty catalog: no Ratel configs were found or all configs have empty `mcpServers`.
- Missing project tools: the host did not expose a useful project root; set `RATEL_PROJECT_ROOT` or run from the project directory.
- First startup failure: `npx` may need network access to resolve the pinned npm package.
- Auth needed: an upstream returned 401 or 403; complete the Ratel auth flow and retry.
