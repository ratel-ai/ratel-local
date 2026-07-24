# Releasing `@ratel-ai/ratel-local`

How a new version is published to npm. Read end-to-end before cutting a release.

## How the pipeline is wired

- **`release.yml`** fires on every `v*` tag push (and supports `workflow_dispatch` with `dry_run: true` for rehearsal). Job graph: `tag-version-check` (asserts `package.json.version` matches the tag and that `CHANGELOG.md` has a `## [<version>]` heading) → `publish-npm` (pnpm install → build → `pnpm pack` → `npm publish --provenance --access public --tag <rc|latest>`) → `github-release`. Authentication is via Trusted Publishers (OIDC) — no `NPM_TOKEN` secret stored in the repo. `*-rc.*` tags publish under the `rc` dist-tag; un-suffixed tags become `latest`.
- **`ts.yml`** runs build / typecheck / lint / test on every PR and on push to `main`.
- **`verify-install.yml`** runs daily and on-demand: `npx -y @ratel-ai/ratel-local@latest --help` on Ubuntu.

## Cutting a release

### Per-release flow

1. **Bump every synchronized version and runtime pin** to the new value (e.g. `0.2.1-rc.1`, then later `0.2.1`): the root, app, core, and UI `package.json` files; both plugin manifests; and the plugin `.mcp.json` package pin. `pnpm check:pack` verifies that they match.
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
5. **Commit, tag, push:**
   ```
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
6. **Watch `release.yml`** to completion. Inspect the GitHub Release on success.
7. **For RCs**: validate the package on a real machine (`npx -y @ratel-ai/ratel-local@rc --help` from a terminal without the package globally installed). Iterate (`-rc.2`, `-rc.3`, …) until happy, then bump to the un-suffixed version and tag again to promote to `latest`.

## Sharp edges

- **`tag-version-check`** will fail if `package.json.version` disagrees with the tag, or if `CHANGELOG.md` has no `## [<version>]` heading. Fix and push a new commit + re-tag.
- **Never republish a version.** npm rejects this. If a release goes wrong after partial publish, bump to the next version (`X.Y.Z+1` or `X.Y.Z-rc.N+1`) and re-tag.
- **Provenance requires OIDC.** Local `npm publish` from a laptop won't have GitHub Actions OIDC. Only publish via the CI workflow.

## First-time bootstrap

Already done. Trusted Publishers for `@ratel-ai/ratel-local` are configured on npm pointing at this repo's `release.yml` and the `release` environment.

If a new package ever needs adding (e.g. a future split), follow npm's "Trusted Publishers" docs: an `npm publish --access public` from any machine boots the package once, then the npm UI gates further publishes behind the OIDC trust relationship.
