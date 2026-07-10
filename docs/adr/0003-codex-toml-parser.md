# 3. Use smol-toml to parse Codex config TOML

Date: 2026-05-29

## Status

Accepted

## Context

Codex stores MCP server definitions in `config.toml`, so the Codex agent host adapter needs to read TOML and update MCP server entries.

TypeScript TOML libraries are good enough for parsing values, but they do not guarantee full-fidelity edits: comments, whitespace, relative item order, and the original table layout can be lost when a parsed object is stringified again. This matters for a user-owned agent config file, where Ratel should avoid rewriting unrelated settings just because it needs to replace MCP entries.

Two alternatives were considered:

1. **Use a TypeScript TOML parser and serializer for all edits** — simple implementation, but it can normalize the whole file and lose comments or ordering.
2. **Use a full-fidelity TOML editor** — better preservation, but the reliable options are heavier and likely require a Rust TOML crate exposed through NAPI or WASM bindings.

## Decision

Use `smol-toml` to parse Codex config TOML. It is small, ESM-compatible, and sufficient for reading the supported Codex MCP server fields.

For writes, prefer text-preserving edits: remove explicit MCP table sections from the original text and append the `ratel-local` table with Ratel's own renderer. This keeps unrelated comments, whitespace, and ordering intact in the normal path.

Keep `smol-toml` stringification only as a structured fallback for shapes the text-preserving path cannot safely edit, such as inline `mcp_servers` definitions. That fallback is acceptable because it is explicit and limited, but it is not the preferred write strategy.

## Consequences

- The Codex integration stays lightweight and easy to ship in the CLI.
- Supported MCP server values are handled through a real TOML parser instead of ad hoc string parsing.
- Normal writes preserve unrelated user-authored TOML text.
- Structured fallback rewrites may normalize formatting, change relative item order, or drop comments in rewritten sections.
- If exact TOML round-tripping becomes important, revisit this decision and evaluate binding to a stronger Rust TOML parser through NAPI or WASM.
