# Changelog

All notable changes to this package are documented here. The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added `ratel-local connect`, a lightweight stdio MCP bridge that carries the agent's resolved project root to the persistent daemon and exposes actionable daemon status/start/setup tools while the daemon is unavailable.

## [0.5.0] - 2026-07-24

### Changed
- Made the Ratel Local plugin the preferred link path in both CLI and UI flows so Codex and Claude Code receive the bundled agent skills; when plugin installation fails, linking reports the failure and applies the reviewed, backed-up explicit MCP gateway fallback.
- Made Claude Code and Codex linking plugin-aware: enabled `ratel-local` plugins now count as host-level Ratel connections in CLI/UI import and link flows, avoiding a second explicit gateway; linking re-enables a disabled Codex plugin MCP server; explicit-plus-plugin duplicates are detected without silently deleting user configuration.
- Strengthened the MCP server instructions so agents search Ratel capabilities before answering substantive requests or concluding that a workflow is unavailable, while exempting casual conversation and pure writing or reasoning.
- Renamed Ratel MCP to Ratel Local: the repository moved from `ratel-ai/ratel-mcp` to `ratel-ai/ratel-local`, the npm package changed from `@ratel-ai/mcp-server` to `@ratel-ai/ratel-local`, and the CLI changed from `ratel-mcp` to `ratel-local`. This is a breaking package/CLI rename: reinstall the new package and rename `$RATEL_MCP_BIN` to `$RATEL_LOCAL_BIN`. Existing agent gateway entries named `ratel-mcp` remain recognized during import/link migration, while rewritten entries use `ratel-local`.
- The persistent daemon now authenticates MCP traffic with `~/.ratel/daemon-token` and builds isolated, ref-counted gateways for user or canonical project scopes while sharing upstream connections between sessions in the same scope.

### Fixed
- Added Agent Setup actions to fix duplicate plugin-plus-MCP installations and promote MCP-only installations to the plugin for both Claude Code and Codex. Plugin promotion removes the explicit fallback only after installation succeeds, and cleanup preserves unrelated MCP entries.

## [0.4.0] - 2026-06-30

### Changed
- **`ratel-mcp mcp link` and `ratel-mcp mcp import` now install the Claude Code statusline automatically** once they finish wiring up Claude Code, instead of requiring a separate `ratel-mcp statusline install` step. A pre-existing non-Ratel statusline is left untouched (reported as a note, not an error).

## [0.3.1] - 2026-06-18

### Changed
- **Skills page (`ratel-mcp ui`) now emphasizes only Ratel-managed skills.** When no skills are managed it shows an empty state with an "Import skills" action instead of listing Claude Code / Codex skills inline. External skills are brought in through a dedicated, paginated import dialog, each row badged by source. The bulk "Manage all" button is replaced by "Import skills"; "Unmanage all", per-skill "Stop managing", and the "New skill" form are unchanged.

### Added
- **Skill import in Agent Setup (`ratel-mcp ui`).** Each agent gets a per-agent "Import skills" flow alongside the existing MCP import/link, plus an "N skills not managed by Ratel" hint on its card and detail page, mirroring the native-tools hint.

## [0.3.0] - 2026-06-17

### Added
- **Skills, served through the gateway.** When a skill catalog is configured, `createMcpServer` / `buildGatewayFromConfig` expose `get_skill_content` alongside `search_capabilities` + `invoke_tool`, and `search_capabilities` returns a `skills` bucket beside `tools`.
- `ratel-mcp skill` CLI: `activate` / `deactivate` move skills between an agent's folder and the Ratel-managed `~/.ratel/skills` so the gateway serves them; `list` shows managed skills; `suggest` ranks skills for a prompt.
- Prompt-aware preload hook: `skill preload-hook` is a Claude Code `UserPromptSubmit` entrypoint that ranks skills against the prompt (lexical match, project-stack tie-break, clear-winner gate) and nudges the agent toward the best skill; `skill install-hook` / `uninstall-hook` register it in `settings.json` (`--scope user|project`).
- **Skills from Claude Code and Codex.** Skills are sourced from both `~/.claude/skills` and `~/.codex/skills`. The manifest records which agent each managed skill came from, so unmanaging one returns it to that agent's folder (Claude → Claude, Codex → Codex). A name present in both agents is listed once per agent and is independently manageable.
- **Skills in the browser UI (`ratel-mcp ui`).** The Skills page groups skills into "Managed by Ratel" (served through the gateway) and "Not managed" (available in Claude Code / Codex), each row badged with its source (Claude / Codex / Ratel). Per-skill "Manage with Ratel" / "Stop managing" plus bulk actions and a "New skill" form. Each skill has a full detail page that renders its instructions as Markdown in read mode and edits the raw `description` / `tags` / instructions in place (managed skills only); the page shows the skill's origin agent. Backed by `GET /api/skills`, `GET` / `PATCH /api/skills/{id}`, `POST /api/skills` (create) and `POST /api/skills/{activate,deactivate}`.
- `ratel-mcp ui` subcommand — a loopback-only browser UI mirroring the CLI, protected by a per-session bearer token. It can view, add, edit, remove, and OAuth-authorize MCP servers across all three scopes; inspect backups; and run agent setup flows. Flags: `--port N`, `--no-open`.
- Agent setup support for both Claude Code and Codex, including host detection, per-agent status, import/link previews, and apply endpoints for the UI.
- Codex MCP config support via `~/.codex/config.toml` and project `.codex/config.toml`.
- `ratel-mcp mcp import` and `ratel-mcp mcp link` now accept `--agent auto|claude-code|codex` so CLI users can target a specific supported agent instead of relying on automatic detection.
- UI assets and navigation for agent links, including Claude Code and Codex branding.

### Changed
- Consume `@ratel-ai/sdk@^0.2.0`: the new discovery tool is `search_capabilities` (returns a `tools` and a `skills` bucket), and the skill model folds author `triggers` into the indexed `tags` and `stacks` into non-indexed `metadata` (ratel ADR-0012).
- Reworked agent import/link internals around supported agent host adapters instead of Claude-only handling.
- Made CLI and README import/link language agent-neutral where the flow now supports multiple agents.
- Backup handling now uses the newer manifest/listing model across CLI and UI routes.
- UI routes now expose preview/apply workflows for importing agent MCP servers into Ratel and linking agents back to the Ratel gateway.

### Removed
- Removed the old backup undo command.

### Fixed
- A skill's `SKILL.md` is rewritten in place on edit: frontmatter keys Ratel doesn't manage (`allowed-tools`, `model`, custom keys, comments) are preserved, the write is atomic, and `description` / `tags` containing quotes or backslashes round-trip without accumulating escape characters (the loader now decodes escaped scalars).
- Agent rewrites consistently install the `ratel-mcp` gateway command.

### Backward compatibility
- The gateway still advertises the deprecated `search_tools` (its pre-0.2.0 tools-only `{ groups }` result) alongside `search_capabilities`, so MCP clients that reference `search_tools` by name keep working unchanged. Its description flags it as deprecated; prefer `search_capabilities`.

## [0.2.0] - 2026-05-12

### Added
- `ratel-mcp` CLI bin shipped alongside the library. Subcommands: `serve`, `mcp add` / `remove` / `list` / `get` / `edit` / `import` / `link` / `auth`, `backup list`. Run via `npx @ratel-ai/mcp-server <verb>` or a global `pnpm add -g`.
- Source split: `src/lib/` (library) + `src/cli/` (CLI) + `src/index.ts` (library entrypoint) + `src/bin.ts` (CLI entrypoint).

### Changed
- Package now hosted in [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-local); previously shipped from the `ratel-ai/ratel` monorepo as one of several workspace packages. Library API surface is unchanged.
- The Claude Code rewrite (`mcp import` / `link`) plants `command: "ratel-mcp"` (was `"ratel"` when this lived inside `@ratel-ai/cli`).
- Bin-locator env var renamed `$RATEL_BIN` → `$RATEL_MCP_BIN`.

### Note
- Extracted from [`ratel-ai/ratel@v0.1.5`](https://github.com/ratel-ai/ratel/tree/v0.1.5). `@ratel-ai/cli` in the source repo still depends on `@ratel-ai/mcp-server@^0.1.5` (library-only, pre-CLI) until its own follow-up refactor lands.
