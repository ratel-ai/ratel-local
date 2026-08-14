---
name: ratel-local
description: Configure, use, and debug the Ratel Local plugin and ratel-local CLI. Use when working with Codex or Claude Code plugin setup, native trace exporters, importing or linking existing MCP servers into Ratel config, adding upstream MCP servers, configuring capability retrieval, running auth, opening the local UI, checking version mismatches, or troubleshooting missing tools and startup failures.
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

The plugin `.mcp.json` runs `npx -y @ratel-ai/ratel-local@0.8.0 connect`.
The connector sends its resolved project root to the authenticated loopback
daemon, which loads the appropriate config chain and shares upstream
connections only within that canonical project scope. Do not replace the
connector with a direct daemon HTTP URL or duplicate upstream MCP definitions
into the plugin `.mcp.json`.

Stable packages install the Ratel marketplace from the repository's default
`main` branch. Only prerelease package versions reconcile the marketplace to an
immutable matching Git tag. Never add an RC branch or ref for stable `0.8.0`.

Run the setup wizard once from a terminal:

```bash
npx -y @ratel-ai/ratel-local@0.8.0 setup
```

This is the default onboarding path: it makes the daemon ready, detects Claude
Code and Codex, connects selected agents through the plugin-first link flow,
then separately offers a previewed and confirmed MCP/skill import.

When the daemon is unavailable, the connector exposes
`ratel_daemon_status`, `ratel_daemon_start`, and `ratel_daemon_setup`. The
setup tool returns the terminal command; interactive setup must never be run on
MCP stdio.

For human CLI work, install the package globally and use the `ratel-local` bin:

```bash
pnpm add -g @ratel-ai/ratel-local@0.8.0
ratel-local --version
```

Node 20.6 or newer is required.

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

- `ratel-local setup` performs complete daemon and agent onboarding. Repeat `--agent` for explicit agent automation; use `--daemon-only` to skip agent onboarding.
- `ratel-local traces` inspects or changes native Claude Code and Codex trace exporters through the daemon control plane.
- `ratel-local connect` bridges one agent session to its scoped daemon gateway.
- `ratel-local daemon` provides lower-level `install`, `start`, `stop`, `restart`, `status`, `uninstall`, and foreground `run` controls.
- `ratel-local serve` starts the MCP gateway over stdio.
- `ratel-local import` migrates agent MCP entries and native skills into Ratel.
- `ratel-local link` points an agent at the Ratel gateway without removing native MCP entries.
- `ratel-local mcp` manages upstream MCP server entries.
- `ratel-local retrieval` inspects and configures scoped BM25, semantic, or hybrid capability search.
- `ratel-local backup` manages backup snapshots.
- `ratel-local project` manages registered project roots.
- `ratel-local skill` manages Claude Code and Codex skills through Ratel.
- `ratel-local doctor` recovers interrupted mutations and diagnoses scoped config/OAuth state.
- `ratel-local daemon open` opens the persistent daemon UI with live client and gateway state.
- `ratel-local ui` opens the persistent daemon UI.
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

`ratel-local retrieval` verbs:

- `status` shows each scoped override and the effective retrieval mode.
- `configure` writes one atomic scoped retrieval override.
- `reset` removes one override so the earlier scope is inherited again.
- `prepare` downloads or verifies a dense model, or checks an Ollama/endpoint source.

`ratel-local skill` verbs:

- `import` imports discovered skills into a user, project, or local registration.
- `add-scope` adds another scoped reference or owned copy for a skill.
- `remove-scope` removes only the selected registration.
- `remove` removes a registration and its owned copy when applicable.
- `list` shows effective, configured, or discovered scoped skills.
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

Run complete interactive onboarding:

```bash
ratel-local setup
```

`setup` is idempotent. It installs, updates, or starts the daemon; detects
Claude Code and Codex; asks which agents to connect through the plugin-first
link flow; and separately offers native MCP servers and skills for preview and
confirmation.

Safe automation:

```bash
# Preserve the historical daemon-only --yes behavior
ratel-local setup --yes
ratel-local setup --daemon-only --yes

# Explicitly connect one or more agents; imports are still skipped
ratel-local setup --yes --agent claude-code --agent codex
ratel-local setup --yes --agent auto

# First installation on a custom daemon port
ratel-local setup --daemon-only --yes --port 7331
```

Never assume `setup --yes` imports native configuration. Use the expert
`ratel-local import --yes --agent <agent>` command only when automated migration
was explicitly requested. `ratel-local daemon`, `ratel-local link`, and
`ratel-local import` remain available for targeted workflows.

Manage native trace and structured-log export through the CLI, never by directly
editing Claude Code or Codex configuration:

Cloud telemetry ships off by default. Before offering setup or changing an
exporter, check `ratel-local traces status`. If the feature is off, explain that
the user must start a foreground daemon with
`RATEL_FEATURE_CLOUD_TELEMETRY=1`, or reinstall a background service with that
environment persisted. Merely exporting the flag before `daemon restart` does
not rewrite an installed service. Do not treat saved Cloud credentials as an
enablement signal.

```bash
# Enable an existing background service
ratel-local daemon uninstall
RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local daemon install

# Roll back by reinstalling without the environment assignment
ratel-local daemon uninstall
ratel-local daemon install
```

These lifecycle commands preserve Ratel configuration and saved Cloud settings.
For a new interactive installation that should offer telemetry onboarding, run
`RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local setup`.

```bash
# Always inspect semantic state first
ratel-local traces status
ratel-local traces status --agent codex --json

# Mutations require explicit host selection
ratel-local traces enable --agent claude-code --agent codex
ratel-local traces enable --agent claude-code --level tool-details
ratel-local traces enable --agent codex --level tool-activity
ratel-local traces disable --agent codex
```

Plain `traces enable` selects Redacted. Claude Code also supports
`--level tool-details` and `--level full-content`. Codex supports
`--level tool-activity` and `--level prompt-content`; Tool activity includes
structured `codex.tool_result` output snippets even with prompt logging off.
Treat all enhanced levels as content-bearing. Interactive runs must confirm the
privacy warning, and automation must pass the explicit level with both
`--confirm-content` and `--yes`. Never enable `OTEL_LOG_RAW_API_BODIES`.

If status reports `stale`, enable safely repairs the old Ratel daemon port. If
it reports `conflict`, explain that replacement is irreversible because Ratel
does not retain the displaced exporter, and request the user's approval before
using `--overwrite`. Non-interactive replacement requires both `--overwrite`
and `--yes`; never infer that approval. Do not request, read, or pass a Ratel
Cloud API key for agent exporter setup. The agent config contains only the
daemon-derived loopback route, and the daemon owns Cloud credentials.

When interactive trace setup reports that Ratel Cloud is not configured, let
the user enter the key directly into the CLI's masked prompt or Agent Setup's
password field. Never ask the user to disclose the key in chat or place it in a
command. If the user needs a key, direct them to
<https://cloud.ratel.sh/settings>. Non-interactive `--yes` runs never prompt for
or consume a Cloud API key.

Plain `setup --yes` deliberately skips traces. Automated setup must be explicit:

```bash
ratel-local setup --yes --traces --agent claude-code --agent codex
```

Inspect configured upstreams:

```bash
ratel-local mcp list
```

Inspect or opt into dense retrieval:

```bash
# BM25 is the model-free default.
ratel-local retrieval status

# Opt one project into the pinned built-in model, then prepare it.
ratel-local retrieval configure --scope project --method hybrid --source built-in
ratel-local retrieval prepare --scope project
```

Treat retrieval as an atomic scoped setting: a narrower scope replaces the
entire earlier retrieval block. Dense configuration is opt-in. After
`configure`, `reset`, `prepare`, or dense OAuth changes, reconnect the affected
agent/context so it acquires the new immutable gateway generation. Use the
Settings page in the daemon UI for the same validated flow and consult
`docs/retrieval.md` in the repository for model, memory, and privacy details.

Run a one-off gateway from the current project without the daemon:

```bash
ratel-local serve --auto-config
```

Open the local UI:

```bash
ratel-local daemon open
```

`ratel-local ui --no-open` prints a persistent daemon UI session URL without
opening a browser.

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
Claude Code agent page in `ratel-local daemon open`. The statusline reports
Ratel as on when Claude Code starts Ratel via a linked MCP entry or an enabled
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
2. Confirm the plugin `.mcp.json` starts `@ratel-ai/ratel-local@0.8.0` with `connect`.
3. Run `ratel-local daemon status`; if needed, run `ratel-local setup`.
4. Run `ratel-local mcp list` to verify Ratel config has upstreams.
5. Run `ratel-local connect` from the relevant project to reproduce the scoped bridge outside the host, or `ratel-local serve --auto-config` to isolate the gateway itself.
6. For HTTP/SSE upstreams, run `ratel-local mcp auth --check` or `ratel-local mcp auth <name>`.
7. In Claude Code, run `/mcp` and `/reload-plugins` after plugin changes.
8. In Codex, restart the thread after plugin install or manifest changes.

Common findings:

- Bootstrap tools only: the daemon is missing or stopped; use `ratel_daemon_status`, then run the setup command returned by `ratel_daemon_setup` or call `ratel_daemon_start` for an installed service.
- Empty catalog: no Ratel configs were found or all configs have empty `mcpServers`.
- Dense retrieval startup failure: run `ratel-local retrieval status`, then `ratel-local retrieval prepare` in the affected project. Reset that scope to BM25 when the configured model or endpoint should not be used.
- Missing project tools: the host did not expose a useful project root; set `RATEL_PROJECT_ROOT` or run from the project directory.
- First startup failure: `npx` may need network access to resolve the pinned npm package version.
- Auth needed: an upstream returned 401 or 403; complete the Ratel auth flow and retry.
