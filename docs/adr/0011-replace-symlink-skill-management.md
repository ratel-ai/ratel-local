# 11. Replace symlink skill management with scoped registrations

Date: 2026-07-31

## Status

Accepted

Supersedes the compatibility-wrapper decision in ADR-0008.

## Context

The pre-scoped skill lifecycle linked native host directories into
`~/.ratel/skills` and tracked those links in a separate manifest. Scoped
registrations later became the authoritative ownership model, leaving two
mutation paths with different import and removal behavior.

Native global skills must remain in their host directory but must not be
automatically invoked there after Ratel starts serving them. Project-scoped
skills are commonly committed, so Ratel must not rewrite their metadata.

## Decision

- Use scoped reference or owned-copy registrations as the only active skill
  lifecycle. Do not create new managed-directory symlinks or manifest entries.
- For a user-scoped reference to a native global skill, transactionally set the
  host's manual-only policy and record enough prior state to restore it when the
  registration is removed.
- Never patch native metadata for project or local registrations.
- Remove the deprecated `skill activate` and `skill deactivate` entry points.
- On daemon startup, atomically migrate only legacy manifest entries whose
  symlink target, native path, and recorded metadata still match exactly.
  Preserve ambiguous entries untouched and report them through
  `ratel-local doctor`; `doctor --fix` runs the same safe migration explicitly.

## Consequences

- CLI, UI, and daemon mutations share one scoped ownership and rollback model.
- Global imports reduce host context growth without copying or moving the
  source skill.
- Repository-owned project skills are not modified.
- A legacy symlink can remain only when verification cannot prove that Ratel
  owns it; manual intervention is then required instead of destructive cleanup.
