# 19. Pin current SDK and temporarily retain the legacy OTLP initializer

Date: 2026-08-14

## Status

Accepted

## Context

Ratel Local 0.8.0 was developed against `@ratel-ai/sdk` 0.5.2 and declared it
with a caret range. A clean package installation therefore selected 0.5.3,
whose patch release removed `configureTelemetry()`, and the CLI failed during
module loading before it could print its version or help.

The current SDK release is 0.9.1. Its catalog APIs remain compatible with the
Local integration, but it deliberately leaves OpenTelemetry provider ownership
to the host. Ratel Local already depends on `@ratel-ai/telemetry-otlp` 0.1.1 for
the trace provider previously reached indirectly through the SDK. Replacing
that legacy package with a fully host-assembled OpenTelemetry provider is useful
follow-up work, but is not required to preserve the reviewed 0.8.0 trace path.

## Decision

- Pin `@ratel-ai/sdk` exactly to 0.9.1 in the published app and private core
  workspace package. Do not use a caret or tilde range for this dependency.
- Replace the removed SDK bootstrap call with a direct call to the existing
  `@ratel-ai/telemetry-otlp` 0.1.1 `init()` function. Pin its compatible
  `@ratel-ai/telemetry` vocabulary to 0.1.2 because the initializer's published
  range admits a later patch that removed exports it imports. Keep its endpoint,
  `service.name`, shutdown ordering, feature gate, and fail-open behavior
  unchanged.
- Retain trace-only behavior. Do not register an OpenTelemetry logs provider or
  adopt the SDK's experimental facts, artifacts, ranking, or experiment APIs as
  part of this compatibility update.
- Make packed-package validation enforce both exact SDK pins. Continue testing
  a freshly installed tarball so dependency resolution is exercised outside the
  workspace lockfile.
- Treat the legacy initializer as explicit temporary debt. A later change may
  replace it with a Local-owned OpenTelemetry provider after separately
  reviewing trace and log provider composition.

This supersedes only ADR 0014's choice to call the SDK's removed
`configureTelemetry()` convenience API. ADR 0014's daemon ownership, trace
routing, shutdown, and non-correlation decisions remain in force. ADR 0018's
feature boundary and fail-open requirements are unchanged.

## Consequences

- Clean global installs cannot drift onto an SDK or legacy telemetry patch with
  a different runtime export surface.
- Ratel Local receives the current SDK's stable catalog and MCP fixes without
  enabling its experimental features.
- Runtime trace export continues through a discontinued compatibility package,
  which is intentionally bounded and documented rather than mistaken for the
  final provider architecture.
- Future SDK upgrades are deliberate dependency changes accompanied by packed
  installation tests.
