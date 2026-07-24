# 6. Private workspaces with one public package

Date: 2026-07-24

## Status

Accepted

Supersedes ADR 0002.

## Context

ADR 0002 chose one published npm package and kept its library and CLI in one
source tree. Ratel Local now includes a persistent daemon, agent adapters,
transactional control planes, a React UI, and the original gateway library.
Keeping all of those concerns in one TypeScript project made dependency
boundaries, test ownership, and browser-versus-Node build settings difficult to
enforce.

Publishing separate core, UI, and CLI packages would expose internal seams to
users and require coordinated releases. The user-facing installation should
remain one package and one CLI.

## Decision

- Keep `@ratel-ai/ratel-local` as the only published package and the owner of
  the `ratel-local` binary.
- Organize implementation into private pnpm workspaces:
  `@ratel-ai/ratel-local-core`, `@ratel-ai/ratel-local-ui`, and the public app
  package.
- Put reusable Node-side configuration, gateway, OAuth, project, and mutation
  behavior in `packages/core`; keep browser UI code in `packages/ui`; keep
  daemon transports, CLI orchestration, packaging, and static asset serving in
  `apps/ratel-local`.
- Bundle private workspace runtime code and copy the required declarations and
  UI assets into the public package during its build. Private workspaces must
  not appear as runtime dependencies in the published manifest.
- Version the private workspaces with the public package so local builds and
  generated artifacts can be checked for skew, without publishing them.

## Consequences

- Users still install, upgrade, and execute one npm package.
- Core and UI can use separate compiler, test, and bundler settings with
  explicit import boundaries.
- The packaging check must verify that the tarball is self-contained and does
  not retain `workspace:` dependencies.
- Release version bumps cover every workspace manifest and the plugin's pinned
  connector version.
- ADR 0002 remains useful history for the single-artifact choice, but its
  single-source-tree and relative-import decisions no longer apply.
