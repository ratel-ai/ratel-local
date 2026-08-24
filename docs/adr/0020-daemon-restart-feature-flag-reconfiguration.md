# 20. Daemon restart feature-flag reconfiguration

Date: 2026-08-24

## Status

Accepted

## Context

ADR 0018 made Cloud telemetry an environment-only, opt-in daemon boundary and
persisted only enabled flags into generated launchd and systemd units. It also
decided that changing that persisted flag required reinstalling the service
definition, and that a plain restart must not reinterpret the invoking shell's
environment.

Operators then needed an explicit uninstall/install cycle to enable or disable
Cloud telemetry on an already-installed background daemon. That cycle is easy
to get wrong, and documenting it as the only path conflicts with the natural
expectation that
`RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local daemon restart` should take effect.

Regenerating the whole service from the invoking shell would also refresh
install-time `PATH` / `RATEL_DAEMON_INSTALL_PATH`, which ADR-era work preserved
so npm/npx cannot reorder agent plugin executables.

## Decision

- On `daemon restart`, if `RATEL_FEATURE_CLOUD_TELEMETRY` is **present** in the
  invoking environment and a service file is installed, rewrite only that
  feature-flag environment entry in the existing launchd or systemd unit, then
  perform the normal stop/start. On Linux, run `systemctl --user daemon-reload`
  after the rewrite.
- If the variable is **absent**, leave the installed service file unchanged and
  only stop/start.
- Presence is the override signal. Only the exact value `1` enables; any other
  present value, including `0`, disables by removing the persisted enabled
  entry. Do not persist `=0`.
- Do not regenerate ProgramArguments, ExecStart, WorkingDirectory, or PATH /
  `RATEL_DAEMON_INSTALL_PATH` as part of this path.
- `daemon start` and `setup` remain non-rewriting for this flag.
  Uninstall/install remains a valid fallback.

This supersedes only ADR 0018's decision that enabling or disabling an existing
background service requires reinstalling its service definition and that a
plain restart does not reinterpret the invoking shell's environment. ADR 0018's
exact-`1` enablement, environment-only boundary, persist-only-enabled-flags,
credential separation, fail-open telemetry boundary, and gated behavior set
remain in force.

## Consequences

- Operators can enable or disable Cloud telemetry on an installed daemon with
  an explicit env assignment on `daemon restart`, and keep it enabled with a
  plain restart.
- Absent-env restarts preserve prior ADR 0018 semantics and do not silently
  disable telemetry.
- Install-time PATH isolation is preserved because restart reconfiguration does
  not regenerate the whole unit from the current shell.
- ADR-0021 is reserved for Cloud credential ownership (week-plan B1).
