# 8. Canonical projects and scoped ownership

Date: 2026-07-24

## Status

Accepted

## Context

Ratel Local reads configuration and skills from user, project, and
machine-local locations. The same repository may be addressed through symlinks,
relative paths, or different agent working directories. Using those raw paths
as identity would create duplicate daemon contexts and could associate OAuth
credentials or owned skill copies with the wrong project.

Scoped values also need deterministic precedence and explicit ownership.
Otherwise a removal at one scope can accidentally delete a value owned by
another scope, or a copied skill can outlive the registration that owns it.

## Decision

- Canonicalize project roots and assign a stable project ID. Persist the mapping
  in the per-user project registry and use the project ID in runtime contexts,
  daemon generations, project-scoped OAuth paths, and UI routes.
- Resolve configuration from broad to narrow: user, project, then local.
  Preserve every configured entry for diagnostics while exposing only the
  effective entry at runtime.
- Store user configuration under `~/.ratel`; store project configuration in
  `.ratel/config.json`; store machine-local overrides in
  `.ratel/config.local.json`.
- Keep local control files out of Git through the local exclude manager rather
  than editing a repository's shared `.gitignore`.
- Register skills explicitly at user, project, or local scope. A reference
  points at an external canonical skill directory; a copy is owned by its
  registration and may be deleted only through an operation that explicitly
  removes the owned copy.
- Keep `skill activate` and `skill deactivate` as deprecated user-scope
  compatibility wrappers for the pre-scoped native-skill linking model.
- Derive OAuth storage from the effective entry's owning scope, canonical
  project ID, and resource fingerprint. Do not reuse credentials when the
  resource identity changes. Migrate legacy unscoped stores only when ownership
  is unambiguous; otherwise require re-authorization.
- Preserve missing projects in the registry for diagnosis, but reject runtime
  access and destructive forget operations while a project is active.

## Consequences

- Equivalent filesystem paths converge on one project context and one set of
  project-scoped credentials.
- Project and local overrides remain isolated even when several agent sessions
  share the daemon.
- Diagnostics can explain shadowed, invalid, missing, or stale registrations
  without silently deleting them.
- Copy ownership and OAuth migration require additional metadata and cleanup
  rules, but removals can be made precise and reversible.
- Filesystem canonicalization and project registry behavior are security
  boundaries and require path/symlink tests.
