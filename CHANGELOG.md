# Changelog

All notable changes to this package are documented here. The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-12

### Added
- `ratel-mcp` CLI bin shipped alongside the library. Subcommands: `serve`, `mcp add` / `remove` / `list` / `get` / `edit` / `import` / `link` / `auth`, `backup list` / `undo`. Run via `npx @ratel-ai/mcp-server <verb>` or a global `pnpm add -g`.
- Source split: `src/lib/` (library) + `src/cli/` (CLI) + `src/index.ts` (library entrypoint) + `src/bin.ts` (CLI entrypoint).

### Changed
- Package now hosted in [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp); previously shipped from the `ratel-ai/ratel` monorepo as one of several workspace packages. Library API surface is unchanged.
- The Claude Code rewrite (`mcp import` / `link`) plants `command: "ratel-mcp"` (was `"ratel"` when this lived inside `@ratel-ai/cli`).
- Bin-locator env var renamed `$RATEL_BIN` → `$RATEL_MCP_BIN`.

### Note
- Extracted from [`ratel-ai/ratel@v0.1.5`](https://github.com/ratel-ai/ratel/tree/v0.1.5). `@ratel-ai/cli` in the source repo still depends on `@ratel-ai/mcp-server@^0.1.5` (library-only, pre-CLI) until its own follow-up refactor lands.
