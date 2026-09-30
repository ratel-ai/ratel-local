# 22. Ratel-owned Skill storage and independent exposure

Date: 2026-09-16

## Status

Accepted

Supersedes [ADR 0011](0011-replace-symlink-skill-management.md).

## Context

ADR-0011 removed managed-directory symlinks because two mutation paths, a link
manifest and scoped registrations, disagreed about who owned a Skill. The scoped
model won, and the links went away with the path that had created them.

That left storage and exposure fused into one choice. A `reference` registration
leaves the content wherever the host put it, so Ratel cannot back it up, version
it, or edit it. An owned `copy` duplicates the tree, so the native host keeps
serving a different file that Ratel does not manage. Where a Skill lives and who
may invoke it are separate questions, and answering both with one mode makes the
common case impossible: manage it in Ratel, keep invoking it natively.

Both installed hosts follow directory symlinks in their global Skill roots, and
Codex follows them in project roots too. A symlink states "one content, two
readers", which is exactly what the fused model cannot express.

## Decision

- Keep one Ratel-owned copy of a managed global Skill at `~/.ratel/skills/<id>`
  and replace the native original with a symlink to it. The copy is the canonical
  content; the original location remains the native exposure path.
- Split a registration into independent dimensions: origin and management
  (`local-managed`, `reference`, `cloud-managed`, `cloud-detached`),
  availability (`available`, `not-found`, `invalid`, `inaccessible`), and, for
  Cloud replicas only, synchronization. Collision and precedence are diagnostics,
  not lifecycle states.
- Express exposure as two independent booleans, `ratelEnabled` and
  `nativeEnabled`. Host adapters translate `nativeEnabled` into what each host
  supports, and a toggle the target host cannot apply is never presented as
  effective.
- Never relocate or symlink referenced content. A `reference` leaves the files
  where they already are, in a project repository or in a native host directory,
  and Ratel governs it through the registration and the host policy alone. A
  project reference is stored in `project/.ratel/config.json` or
  `config.local.json`; a moved path reports `not-found` instead of being repaired
  automatically.
- Allow a native global Skill to be registered as a reference instead of taken
  over. Ratel then manages and serves it without moving or copying a file, and it
  stays natively available because it never left the host directory. This is also
  what a platform that cannot create the symlink offers, as an explicit choice
  rather than a silent fallback.
- Store the real path of the content in every registration, including a managed
  copy or a Cloud replica. One field answers where the files are for every origin.
- Keep Cloud replicas read-only locally, and store them per credential profile at
  `~/.ratel/cloud/<profile>/skills/<id>`, never under `~/.ratel/skills`. A
  profile carries exactly one Cloud project, so two projects that publish the
  same id arrive through two profiles and land in two directories. A profile is
  selected per directory, so a replica is active only in a context whose resolved
  profile is the one it was fetched with. Its registration stays in the
  machine-local user configuration, keyed by profile and id, because revisions
  and snapshot references do not belong in a committed project file.
- Allow one local conversion of a Cloud replica: an explicit detach that preserves
  the id, the path, the links, and the exposure settings, and disables
  synchronization.
- Make every import, migration, duplication, detach, and update one journaled
  transaction with a complete snapshot captured first, under ADR 0009.
- On Windows, fail an operation whose symlink cannot be created, name the
  privilege it needs, and offer the reference registration instead. No silent
  fallback to a copy or a junction.
- Never inspect, commit, or restore Git state.
- Ship behind `RATEL_FEATURE_SKILL_STORAGE`, off by default, until migration,
  restore, host policy restoration, and crash recovery are covered end to end.

## Consequences

- A managed Skill has one editable location, so backup, restore, duplication, and
  Cloud synchronization all act on a single tree.
- The symlinks ADR 0011 forbade return, but under scoped registrations and a
  journaled transaction instead of a separate manifest. The split ownership that
  motivated their removal does not return with them.
- A Cloud Skill is visible only where its profile applies. Native host roots have
  no notion of directory, so exposing a Cloud replica natively makes it visible in
  every session of that host, and two replicas sharing an id cannot both be
  exposed.
- Deleting `~/.ratel/skills/<id>` outside Ratel leaves a dangling symlink in the
  host directory. Diagnostics have to report it and restore has to repair it.
- Windows without the symlink privilege cannot take over a native global Skill. It
  can still register it as a reference, so the Skill is managed by Ratel and stays
  natively available. What it gives up is the single canonical copy that backup,
  restore, editing, and Cloud synchronization act on.
- Migration away from `reference` and `copy` is destructive on the filesystem, so
  it stays preview-first and snapshot-backed.
- `skill activate` and `skill deactivate`, removed by ADR 0011, do not come back.
  Exposure is the two booleans.
