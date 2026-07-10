# 4. Rename Ratel MCP to Ratel Local

Date: 2026-07-10

## Status

Accepted

## Context

The repository, npm package, CLI binary, plugin, and internal workspace packages used a mix of MCP-oriented names. Those names described the original gateway implementation but no longer represented the broader local product, which also manages agent configuration, skills, OAuth, backups, and a browser UI.

The existing names appear in installed agent configurations and shell environments, so changing them requires an explicit migration boundary. Accepted ADRs 0002 and 0003 retain the identifiers that were current when those decisions were recorded.

## Decision

This ADR supersedes only the package, CLI, gateway-entry, and generated-table identifiers recorded in ADRs 0002 and 0003. Their architectural decisions remain Accepted.

Use Ratel Local as the product name and adopt these identifiers for all new installations and generated configuration:

- Repository: `ratel-ai/ratel-local`
- npm package: `@ratel-ai/ratel-local`
- CLI binary and generated agent gateway entry: `ratel-local`
- Binary override environment variable: `$RATEL_LOCAL_BIN`
- Internal workspace packages: `@ratel-ai/ratel-local-core` and `@ratel-ai/ratel-local-ui`
- Claude Code and Codex plugin/skill identifiers: `ratel-local`

Continue recognizing existing agent gateway entries named `ratel` or `ratel-mcp` as Ratel-owned during import and link operations. When an agent configuration is rewritten, replace them with the canonical `ratel-local` entry rather than importing an old gateway as an upstream server.

## Consequences

- Users must install `@ratel-ai/ratel-local`, invoke `ratel-local`, and rename `$RATEL_MCP_BIN` to `$RATEL_LOCAL_BIN` where configured.
- Existing `ratel-mcp` gateway entries remain safe to import or link and migrate to `ratel-local` on rewrite.
- Historical changelog entries and Accepted ADRs keep their original identifiers; current documentation uses the new names.
- The single-package architecture from ADR 0002 and the text-preserving TOML strategy from ADR 0003 remain unchanged.
