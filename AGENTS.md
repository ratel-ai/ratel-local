# AGENTS.md

Guidance for coding agents working on **Ratel Local** — the MCP gateway that fronts
Claude Code / Codex / Cursor with capability search. Shipped as `@ratel-ai/ratel-local`.

pnpm workspace: `packages/core`, `packages/ui`, `apps/ratel-local`, `e2e/`.

## Setup

- Node 24+, pnpm 10+.
- `pnpm install`

## Core commands

```bash
pnpm build       # tsc → dist/
pnpm typecheck
pnpm lint        # biome
pnpm test        # vitest
```

CI (`.github/workflows/ts.yml`) runs all four on every PR. **Land green.**

## Rules

- **TDD on library and CLI logic.** Red → green → refactor (vitest).
- **Conventional-commits-ish prefixes:** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`. Scopes optional but useful (`fix(cli):`).
- **No tool-attribution lines in commit messages** (no `Co-Authored-By: Claude`, etc.).
- **Keep PRs focused** — one logical change per PR. Update `README.md` / `CHANGELOG.md` in the same PR when the change affects them.
- **ADRs are immutable once Accepted** (`docs/adr/`) — supersede with a new ADR rather than editing.

## Ways of working

- **Avoid breaking changes whenever avoidable.** Prefer additive, backward-compatible changes. When a break is genuinely unavoidable, call it out explicitly (PR description + `CHANGELOG.md`) and provide a migration path.
- **Develop behind feature flags.** Gate new features — and any change to existing behaviour — behind a flag/config that is **off by default**, so it can ship dark, be rolled out incrementally, and be reverted without a code change. Remove the flag once the behaviour is the stable default.

## More detail

- Contributing & conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Release process: [`RELEASING.md`](RELEASING.md)
- Architecture decisions: [`docs/adr/`](docs/adr/)
