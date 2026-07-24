# 9. Transactional control-plane mutations

Date: 2026-07-24

## Status

Accepted

## Context

Import, link, scoped MCP edits, skill registration, and agent repair can touch
several user-owned files in one logical operation. A process crash, concurrent
CLI/UI request, or edit made after a preview can otherwise leave configuration
half-applied or overwrite a user's newer change.

These operations also cross trust boundaries: project paths, manifests, and
symlinks may be stale or crafted. A rollback mechanism is not sufficient if the
write plan itself can escape the intended control paths.

## Decision

- Express multi-file changes as prepared operations with a preview, opaque
  change ID, expiration, commit, and cancellation.
- Record document revisions during preparation and use compare-and-swap checks
  at commit time. A stale preview fails rather than overwriting newer content.
- Serialize cross-process mutations with a lock rooted in the Ratel control
  directory.
- Before writes, validate that project control paths and owned-copy targets
  remain within their canonical roots and do not traverse unsafe symlinks.
- Create backups for user-owned files and journal transaction progress before
  applying the plan. Commit file replacements atomically where the platform
  permits.
- On failure, roll back completed steps from the journal. On startup or
  `doctor`, detect interrupted transactions and finish recovery before new
  mutations or OAuth ownership migration.
- Publish affected runtime contexts only after a successful commit so the
  daemon resolves and advertises a coherent post-transaction snapshot.
- Keep read-only discovery and preview separate from commit; UI and CLI must use
  the same control-plane operations rather than duplicating write logic.

## Consequences

- Users can review impactful changes and concurrent edits produce explicit
  conflicts.
- A crash may leave a journal temporarily, but recovery has enough information
  to restore or complete a consistent state.
- Every new mutation flow must define its scope, revisions, safety checks,
  backup behavior, and affected runtime contexts.
- Simple single-file edits carry more orchestration, while imports and repairs
  avoid silent partial success.
- Mutation engine and recovery compatibility become durable on-disk concerns.
