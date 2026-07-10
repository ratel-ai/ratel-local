# 2. Single npm package — library + CLI shipped together

Date: 2026-05-12

## Status

Accepted

## Context

The `@ratel-ai/ratel-local` package serves two distinct consumption modes:

- **Library**: an application embedding `createMcpServer` / `buildGatewayFromConfig` to expose its own `ToolCatalog` over MCP from its own process.
- **CLI**: a user running `npx @ratel-ai/ratel-local serve` (or `mcp add` / `mcp import` / etc.) without writing any TypeScript — the package itself owns the entrypoint.

The library API and the CLI surface share the same configuration types (`RatelConfig`, `ServerEntry`), the same OAuth flow (`runAuthFlow`, `RatelOAuthStore`), and the same gateway construction (`buildGatewayFromConfig`). Splitting them across two npm packages would force every CLI consumer to install both, version-lock them in lockstep, and live with an extra abstraction layer between the wrappers and the actual implementation. A monorepo with two workspace packages internally would add release-coordination tax for no end-user benefit.

Two alternatives were considered:

1. **Two packages** — `@ratel-ai/ratel-local` (library) and `@ratel-ai/ratel-local-cli` (CLI depending on the library). Clean separation of concerns; doubles the version-bump surface area and forces two `npm install`s for the standalone CLI use case.
2. **CLI as a separate scope** — `@ratel-ai/ratel-local` (CLI) + `@ratel-ai/ratel-local` (library). Same lockstep pain plus a confusing naming split.

## Decision

Ship the library and the CLI from a single npm package, `@ratel-ai/ratel-local`. The package manifest:

- `main` and `types` point at the library entrypoint (`./dist/index.js` / `./dist/index.d.ts`).
- `bin: { "ratel-local": "./dist/bin.js" }` exposes the CLI under the global command `ratel-local` (and via `npx @ratel-ai/ratel-local ...`).
- Source is organized as `src/lib/` (library) + `src/cli/` (CLI) — the split is preserved in source for clarity but collapses into one published artifact.
- The CLI's internal imports point at `src/lib/index.ts` via relative paths, so the public library boundary is the same one external consumers see.

## Consequences

- Library-only consumers pay no observable cost: tree-shakers drop the `src/cli/` subtree from their bundles since it's never reached from `src/index.ts`. Node runtime startup for `import { createMcpServer } from "@ratel-ai/ratel-local"` only loads what's reachable.
- CLI-only consumers get a single `npx` invocation with no peer-dependency dance.
- Releases bump one version, write one CHANGELOG, publish one tarball. The release pipeline stays a single-job npm publish.
- If the CLI ever grows to need transitive dependencies (extra UI libraries, etc.) that library-only consumers don't want, this decision needs revisiting — the package would carry weight unrelated to the library use case. Today the CLI's deps (`@clack/prompts`) are small and uncontroversial.
- Internal seam is enforced by code style, not by the package boundary: cli code may only import from `../lib/index.js`, never reach into `../lib/oauth/store.js` directly. Violations surface at review time, not at install time.
