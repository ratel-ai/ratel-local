# Contributing to `@ratel-ai/ratel-local`

This package is the MCP-server half of [Ratel](https://github.com/ratel-ai/ratel). Issues and PRs are welcome; the library API tracks the MCP spec evolution closely, so spec-aligned changes are easiest to land.

## Prerequisites

- Node 24+
- pnpm 10+

## Build & test

```bash
pnpm install
pnpm build       # tsc → dist/
pnpm typecheck
pnpm lint        # biome
pnpm test        # vitest
```

CI (`.github/workflows/ts.yml`) runs all of these on every PR. Land green.

## Conventions

- **TDD on library and CLI logic.** Red → green → refactor. Vitest in this repo.
- **Conventional-commits-ish prefixes** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`). Scopes optional but useful (`feat(oauth):`, `fix(cli):`).
- **No tool-attribution lines** in commit messages (no `Co-Authored-By: Claude` etc.).
- **ADRs are immutable once Accepted** — write a new ADR that supersedes the old one rather than editing.

## Ways of working

- **Avoid breaking changes whenever avoidable.** Prefer additive, backward-compatible changes. When a break is genuinely unavoidable, call it out explicitly (PR description + `CHANGELOG.md`) and provide a migration path.
- **Develop behind feature flags.** Gate new features — and any change to existing behaviour — behind a flag/config that is off by default, so it can ship dark, be rolled out incrementally, and be reverted without a code change. Remove the flag once the behaviour is the stable default.

## Pull requests

- Keep PRs focused — one logical change per PR.
- Update `README.md` / `CHANGELOG.md` in the same PR if the change affects them.
- Tag `@claude` to invoke automated review on GitHub if useful.

## Releases

See [`RELEASING.md`](RELEASING.md). Short version: bump `package.json`, prepend a `## [X.Y.Z]` section to `CHANGELOG.md`, commit + tag + push. CI handles npm via Trusted Publishers — no stored tokens.

RC-first is the convention: ship `X.Y.Z-rc.0` first (`--tag rc`), smoke it on a real machine, then bump to `X.Y.Z` and tag again to promote to `latest`.

## License

Contributions are licensed under the project's [MIT License](LICENSE.md). By submitting a PR you agree your contribution is licensed accordingly.
