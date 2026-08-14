# Releasing `@ratel-ai/ratel-local`

How a new version is published to npm. Read end-to-end before cutting a release.

## How the pipeline is wired

- **`release.yml`** fires on every `v*` tag push (and supports `workflow_dispatch` with `dry_run: true` for rehearsal). Job graph: `tag-version-check` (asserts `package.json.version` matches the tag and that `CHANGELOG.md` has a `## [<version>]` heading) → `publish-npm` (pnpm install → build → `pnpm pack` → `npm publish --provenance --access public --tag <rc|latest>`) → `github-release`. Authentication is via Trusted Publishers (OIDC) — no `NPM_TOKEN` secret stored in the repo. `*-rc.*` tags publish under the `rc` dist-tag; un-suffixed tags become `latest`.
- **`ts.yml`** runs build / typecheck / lint / test plus packed-package smoke checks on Linux x64/arm64, macOS x64/arm64, and Windows x64 on every PR and on push to `main`.
- **`verify-install.yml`** runs daily and on-demand: `npx -y @ratel-ai/ratel-local@latest --help` on Ubuntu.

## Stable and prerelease channels

- A stable release uses an exact `X.Y.Z` version and `vX.Y.Z` tag. The workflow
  publishes it under npm's `latest` dist-tag. Stable plugin installation follows
  the repository's default `main` branch and must not carry an RC branch or tag
  override.
- A prerelease uses an exact `X.Y.Z-rc.N` version and matching immutable
  `vX.Y.Z-rc.N` tag. The workflow publishes it under npm's `rc` dist-tag, and
  the package's plugin installer pins both Codex and Claude Code marketplaces to
  that matching Git tag.
- Treat `@rc` as a convenience only while an active prerelease is newer than
  production. Exact prerelease versions are the reproducible install path. After
  a GA promotion, do not leave `rc` pointing at an older release than `latest`.

## Cutting a release

### Per-release flow

1. **Bump every synchronized version and runtime pin** to the new value (e.g. `0.2.1-rc.1`, then later `0.2.1`): the root, app, core, and UI `package.json` files; both plugin manifests; the plugin `.mcp.json` package pin; and matching pins in the root README, plugin README, and bundled `ratel-local` skill. The Codex and Claude marketplace manifests are versionless, path-based catalogs; verify that both still resolve `./apps/ratel-local/plugin`. `pnpm check:pack` verifies the versions, runtime pins, and marketplace sources together.
2. **Update `CHANGELOG.md`** — add a `## [<version>] - YYYY-MM-DD` section above the previous one. For GA versions, collapse any matching `## [X.Y.Z-rc.*]` sections into the new `## [X.Y.Z]`.
3. **Verify locally:**
   - `pnpm install --frozen-lockfile`
   - `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
   - Pack to a temporary directory and inspect the tarball:
     ```
     RATEL_PACK_DIR="$(mktemp -d)"
     pnpm --filter @ratel-ai/ratel-local pack --pack-destination "$RATEL_PACK_DIR"
     tar -xOf "$RATEL_PACK_DIR"/ratel-ai-ratel-local-*.tgz package/package.json
     ```
     The packed `package.json` must show real semver ranges; workspace-protocol dependencies would break installs.
4. **(Optional dry-run)** `workflow_dispatch` `release.yml` with `dry_run: true` to validate the auth + publish path end-to-end without consuming a version number.
5. **Commit the release preparation** on `release/X.Y.Z` (or the corresponding
   prerelease branch), open a PR to `main`, and merge it only after CI and review.
   Create the tag from the verified merged `main` commit, then push the tag:
   ```
   git add <release-files>
   git commit -m "release: vX.Y.Z"
   git push origin release/X.Y.Z
   # open and merge the PR, then:
   git switch main
   git pull --ff-only origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
6. **Watch `release.yml`** to completion. Inspect the GitHub Release on success.
7. **For RCs**: validate the exact package version on a real machine (for
   example, `npx -y @ratel-ai/ratel-local@0.8.0-rc.1 --help`) from a terminal
   without the package globally installed. Iterate (`-rc.2`, `-rc.3`, …) until
   happy, then bump every synchronized pin to the un-suffixed version and tag
   again to promote to `latest`.
8. **After a GA promotion**, inspect `npm view @ratel-ai/ratel-local dist-tags
   --json`. If `rc` points to a version older than `latest`, an npm maintainer
   must remove the obsolete tag with authenticated registry access:
   `npm dist-tag rm @ratel-ai/ratel-local rc`. Trusted Publisher OIDC covers the
   publish command but not general registry mutations such as `dist-tag`; this
   cleanup is a separate approval-gated public action. A later RC publish will
   recreate the `rc` tag.

## Sharp edges

- **`tag-version-check`** will fail if `package.json.version` disagrees with the tag, or if `CHANGELOG.md` has no `## [<version>]` heading. Fix and push a new commit + re-tag.
- **Never republish a version.** npm rejects this. If a release goes wrong after partial publish, bump to the next version (`X.Y.Z+1` or `X.Y.Z-rc.N+1`) and re-tag.
- **Provenance requires OIDC.** Local `npm publish` from a laptop won't have GitHub Actions OIDC. Only publish via the CI workflow.

## First-time bootstrap

Already done. Trusted Publishers for `@ratel-ai/ratel-local` are configured on npm pointing at this repo's `release.yml` and the `release` environment.

If a new package ever needs adding (e.g. a future split), follow npm's "Trusted Publishers" docs: an `npm publish --access public` from any machine boots the package once, then the npm UI gates further publishes behind the OIDC trust relationship.
