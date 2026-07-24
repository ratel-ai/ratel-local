# 10. Setup orchestrates complete onboarding

Date: 2026-07-24

## Status

Accepted

## Context

Ratel Local requires three related operations before an agent can use the
persistent gateway:

1. install, update, or start the per-user daemon;
2. connect each supported agent through the Ratel Local plugin, with the
   reviewed explicit MCP connector as fallback;
3. optionally migrate native MCP servers and skills into Ratel.

Exposing only the expert `daemon`, `link`, and `import` commands made new users
discover and order those operations themselves. Folding every operation into
unattended setup would be unsafe because import removes selected native MCP
entries from the source agent and changes skill management metadata.

## Decision

- Make `ratel-local setup` the default interactive onboarding orchestrator.
- Complete daemon installation, version replacement, or startup before agent
  onboarding.
- Detect Claude Code and Codex independently and ask which detected agents to
  connect.
- Reuse the existing plugin-first `link` workflow for every selected agent. Do
  not create a second agent-link implementation inside setup.
- Offer import as a separate opt-in step after linking. Reuse the existing
  transactional import preview and commit confirmation, including conflict
  handling and backups.
- Keep `daemon`, `link`, and `import` as expert commands for repair, targeted
  operations, and scripting.
- Allow repeatable `--agent claude-code|codex`; treat `--agent auto` as every
  detected supported agent.
- Preserve safe unattended behavior:
  - plain `setup --yes` changes only daemon lifecycle state;
  - agent changes require an explicit `--agent`;
  - setup never imports native configuration under `--yes`;
  - `--daemon-only` skips detection and agent onboarding and conflicts with
    `--agent`.

## Consequences

- New users have one ordered workflow while expert commands remain composable.
- Interactive setup may change both service state and selected agent
  configuration, but agent links remain idempotent and use the existing
  transactional mutation machinery.
- Cancelling agent onboarding does not roll back a daemon that was already made
  ready; setup reports that boundary explicitly.
- Automated native migration requires the visibly destructive expert command
  `ratel-local import --yes --agent <agent>`.
- Future onboarding steps should be composed from their authoritative command
  workflows and must define equally explicit unattended safety semantics.
