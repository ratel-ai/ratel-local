# 5. Prefer agent plugins for linking

Date: 2026-07-17

## Status

Accepted

## Context

Ratel Local can connect to Claude Code and Codex either through the Ratel Local plugin or through an explicit MCP server entry in the agent configuration. The plugin is the richer installation because it bundles the gateway, operational skills, and hooks, while the explicit MCP entry remains a useful fallback when plugin installation is unavailable.

Treating these paths independently can register the gateway twice. Duplicate connections waste resources and make ownership unclear, but automatically deleting configuration during detection would mutate user state without review. Migrating an existing explicit connection also needs to avoid leaving the agent disconnected when plugin installation fails.

## Decision

- Prefer installing the `ratel-local` plugin when linking Claude Code or Codex.
- Fall back to a reviewed, backed-up explicit MCP gateway change only when plugin installation fails.
- Model the host-level Ratel connection as `none`, `explicit`, `plugin`, or `duplicate`, and surface that state consistently in CLI and UI flows.
- Treat an enabled plugin as an existing Ratel connection. Do not add another explicit gateway, and re-enable the bundled Codex MCP server when the plugin is enabled but that server is disabled.
- Detect duplicate plugin-plus-explicit installations without changing either path automatically. Agent Setup may offer an explicit repair action that keeps the plugin and removes only entries positively identified as Ratel gateways.
- For MCP-only promotion, install the plugin first and remove the explicit gateway only after installation succeeds. If installation fails, preserve the existing MCP connection unchanged.
- Use the normal agent-config preview, rewrite, and backup machinery for every explicit gateway removal, preserving unrelated MCP entries and scopes.

## Consequences

- Claude Code and Codex receive the bundled plugin capabilities whenever installation is supported.
- Linking remains usable in environments where the plugin installer is missing or fails.
- Detection is read-only; users choose when duplicate configuration is removed.
- Plugin promotion cannot disconnect a working MCP-only installation merely because plugin installation failed.
- Host adapters remain responsible for format-preserving JSON or TOML rewrites, while connection policy stays shared across hosts.
