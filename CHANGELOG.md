# Changelog

All notable changes to this package are documented here. The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0-rc.0] - 2026-06-10

### Added
- `ratel-mcp ui` subcommand — a loopback-only browser UI mirroring the CLI, protected by a per-session bearer token. It can view, add, edit, remove, and OAuth-authorize MCP servers across all three scopes; inspect backups; and run agent setup flows. Flags: `--port N`, `--no-open`.
- Agent setup support for both Claude Code and Codex, including host detection, per-agent status, import/link previews, and apply endpoints for the UI.
- Codex MCP config support via `~/.codex/config.toml` and project `.codex/config.toml`.
- `ratel-mcp mcp import` and `ratel-mcp mcp link` now accept `--agent auto|claude-code|codex` so CLI users can target a specific supported agent instead of relying on automatic detection.
- UI assets and navigation for agent links, including Claude Code and Codex branding.

### Changed
- Reworked agent import/link internals around supported agent host adapters instead of Claude-only handling.
- Made CLI and README import/link language agent-neutral where the flow now supports multiple agents.
- Backup handling now uses the newer manifest/listing model across CLI and UI routes.
- UI routes now expose preview/apply workflows for importing agent MCP servers into Ratel and linking agents back to the Ratel gateway.

### Removed
- Removed the old backup undo command.

### Fixed
- Agent rewrites consistently install the `ratel-mcp` gateway command.

## [0.2.0] - 2026-05-12

### Added
- `ratel-mcp` CLI bin shipped alongside the library. Subcommands: `serve`, `mcp add` / `remove` / `list` / `get` / `edit` / `import` / `link` / `auth`, `backup list`. Run via `npx @ratel-ai/mcp-server <verb>` or a global `pnpm add -g`.
- Source split: `src/lib/` (library) + `src/cli/` (CLI) + `src/index.ts` (library entrypoint) + `src/bin.ts` (CLI entrypoint).

### Changed
- Package now hosted in [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp); previously shipped from the `ratel-ai/ratel` monorepo as one of several workspace packages. Library API surface is unchanged.
- The Claude Code rewrite (`mcp import` / `link`) plants `command: "ratel-mcp"` (was `"ratel"` when this lived inside `@ratel-ai/cli`).
- Bin-locator env var renamed `$RATEL_BIN` → `$RATEL_MCP_BIN`.

### Note
- Extracted from [`ratel-ai/ratel@v0.1.5`](https://github.com/ratel-ai/ratel/tree/v0.1.5). `@ratel-ai/cli` in the source repo still depends on `@ratel-ai/mcp-server@^0.1.5` (library-only, pre-CLI) until its own follow-up refactor lands.
