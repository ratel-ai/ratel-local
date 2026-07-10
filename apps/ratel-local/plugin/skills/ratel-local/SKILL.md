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

The plugin starts a small stdio connector; one persistent local daemon owns the
gateway instances. Keep upstream MCP definitions in Ratel config files, not in
the plugin `.mcp.json`.

## Plugin Runtime

The plugin `.mcp.json` runs `npx -y @ratel-ai/ratel-local@0.5.0 connect`.
The connector sends its resolved project root to the authenticated loopback
daemon, which loads the appropriate config chain and shares upstream
connections only within that canonical project scope. Do not replace the
connector with a direct daemon HTTP URL or duplicate upstream MCP definitions
into the plugin `.mcp.json`.

Run the setup wizard once from a terminal:

```bash
npx -y @ratel-ai/ratel-local@0.5.0 setup
```

When the daemon is unavailable, the connector exposes
`ratel_daemon_status`, `ratel_daemon_start`, and `ratel_daemon_setup`. The
setup tool returns the terminal command; interactive setup must never be run on
MCP stdio.

For human CLI work, install the package globally and use the `ratel-local` bin:

```bash
pnpm add -g @ratel-ai/ratel-local@0.5.0-rc.0
ratel-local --version
```

Node 20 or newer is required.

## Config Scopes

Ratel config is layered from broad to narrow:

- `user`: `~/.ratel/config.json`
- `project`: `<project>/.ratel/config.json`
- `local`: `<project>/.ratel/config.local.json`

Prefer `project` for team-shared tools, `local` for machine-specific tools or secrets, and `user` for personal tools used across projects.

`connect` resolves the project root from `--project-root`,
`RATEL_PROJECT_ROOT`, `CLAUDE_PROJECT_DIR`, then its working directory. The
daemon loads user config plus project and local configs for that root. If
project tools are missing inside a host, check the resolved working directory
or set `RATEL_PROJECT_ROOT` explicitly.

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

- `ratel-local setup` installs or starts the persistent daemon interactively; use `--yes` for automation.
- `ratel-local connect` bridges one agent session to its scoped daemon gateway.
- `ratel-local daemon` provides lower-level `install`, `start`, `stop`, `restart`, `status`, `uninstall`, and foreground `run` controls.
- `ratel-local serve` starts the MCP gateway over stdio.
- `ratel-local import` migrates agent MCP entries and native skills into Ratel.
- `ratel-local link` points an agent at the Ratel gateway without removing native MCP entries.
- `ratel-local mcp` manages upstream MCP server entries.
- `ratel-local backup` manages backup snapshots.
- `ratel-local skill` manages Claude Code and Codex skills through Ratel.
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
- `auth` runs OAuth for HTTP/SSE upstreams or checks stored auth state.

`ratel-local skill` verbs:

- `activate` links native Claude Code and Codex skills into Ratel as invoke-only without moving their folders.
- `deactivate` removes Ratel-managed links and restores Ratel-owned metadata edits.
- `list` shows the skills Ratel currently manages.
- `suggest` ranks skills for a prompt.
- `preload-hook` is the `UserPromptSubmit` hook entrypoint.
- `install-hook` registers the preload hook in `settings.json`.
- `uninstall-hook` removes the preload hook from `settings.json`.

`ratel-local statusline` verbs:

- no verb renders the Claude Code statusline from stdin.
- `install` writes the user-scope Claude Code `~/.claude/settings.json` statusLine.
- `uninstall` removes only a Ratel-owned statusLine.
- `install --force` replaces another configured statusLine.

## Common Workflows

Install or repair the persistent daemon:

```bash
ratel-local setup
ratel-local setup --yes
ratel-local setup --port 7331
```

`setup` is idempotent: it succeeds immediately when the matching daemon is
running, starts an installed service, offers to replace an incompatible daemon
version, or asks before installing a missing service. Keep MCP import/link as
separate workflows.

Inspect configured upstreams:

```bash
ratel-local mcp list
```

Run a one-off gateway from the current project without the daemon:

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

If the selected agent is not linked, interactive import first offers to link
and continue, continue without linking, or cancel. Import then resolves
selected MCP entries against the matching Ratel scopes: the conflict strategy
decides whether to add the incoming definition, replace the Ratel definition,
or keep the existing Ratel definition. Entries covered by the resulting plan
are removed from the source agent, and selected native skills are managed as
invoke-only.

Preview or automate an import:

```bash
ratel-local import --agent codex --dry-run
ratel-local import --agent codex --yes --conflict-strategy add-missing-only
```

Supported conflict strategies are `add-missing-only`, `replace-selected`, and
`replace-from-agent`. `--dry-run` performs no writes. `--yes` accepts the
non-interactive defaults; do not combine `replace-selected` with `--yes` or
`--dry-run` because per-conflict choices require interaction.

Link a host to the Ratel gateway without importing or removing native MCP
entries:

```bash
ratel-local link --agent codex
ratel-local link --agent claude-code
```

`ratel-local link` changes only the gateway configuration; it never installs the
Claude Code statusline. After a successful Claude Code import, import offers a
separate, skippable statusline step when the Ratel statusline is not already
installed. With `--yes`, import installs a missing statusline automatically but
leaves an existing non-Ratel statusline unchanged. Manage it directly with:

```bash
ratel-local statusline install
ratel-local statusline install --force
ratel-local statusline uninstall
```

Claude Code plugins cannot currently set top-level `statusLine` defaults
directly; use the standalone statusline CLI, the optional import step, or the
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
2. Confirm the plugin `.mcp.json` starts `@ratel-ai/ratel-local@0.5.0` with `connect`.
3. Run `ratel-local daemon status`; if needed, run `ratel-local setup`.
4. Run `ratel-local mcp list` to verify Ratel config has upstreams.
5. Run `ratel-local connect` from the relevant project to reproduce the scoped bridge outside the host, or `ratel-local serve --auto-config` to isolate the gateway itself.
6. For HTTP/SSE upstreams, run `ratel-local mcp auth --check` or `ratel-local mcp auth <name>`.
7. In Claude Code, run `/mcp` and `/reload-plugins` after plugin changes.
8. In Codex, restart the thread after plugin install or manifest changes.

Common findings:

- Bootstrap tools only: the daemon is missing or stopped; use `ratel_daemon_status`, then run the setup command returned by `ratel_daemon_setup` or call `ratel_daemon_start` for an installed service.
- Empty catalog: no Ratel configs were found or all configs have empty `mcpServers`.
- Missing project tools: the host did not expose a useful project root; set `RATEL_PROJECT_ROOT` or run from the project directory.
- First startup failure: `npx` may need network access to resolve the pinned npm package version.
- Auth needed: an upstream returned 401 or 403; complete the Ratel auth flow and retry.
