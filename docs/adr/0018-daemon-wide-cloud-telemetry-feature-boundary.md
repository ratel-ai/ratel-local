# 18. Daemon-wide Cloud telemetry feature boundary

Date: 2026-08-14

## Status

Accepted

## Context

ADRs 0013 through 0017 incrementally introduced the daemon-owned Cloud OTLP
relay, persisted Cloud settings, Ratel runtime export, native-agent exporter
setup, and host-aware telemetry levels. ADR 0015 removed the original
experimental flag because missing credentials already prevented forwarding.

The completed integration has a broader boundary than forwarding alone. It can
read a persisted Cloud credential, mount unauthenticated loopback OTLP ingest
routes, install a process-wide telemetry provider, offer native-agent config
mutations, and surface setup and UI controls. Treating credential presence as
enablement would allow a saved key to activate new network behavior after an
upgrade. These experimental behaviors need one coherent, reversible opt-in
that does not change the layered Ratel configuration model.

Cloud integration failures also must not take down the Local MCP gateway. The
gateway is the primary product path; telemetry is an optional observer.

## Decision

- Add one daemon-startup environment feature flag,
  `RATEL_FEATURE_CLOUD_TELEMETRY`. Only the exact value `1` enables the
  feature. Unset, `0`, and every other value are disabled.
- Keep the flag environment-only. It is a process-wide startup and network
  boundary, not a user/project/local Ratel setting. Persisted Cloud endpoint and
  credential settings remain separate and cannot enable the feature.
- Gate the complete behavior as one unit: persisted Cloud credential loading,
  environment Cloud option parsing, loopback trace and log relay routes, Ratel
  runtime telemetry-provider installation, native exporter mutations, setup
  prompts, and UI controls. While disabled, relay routes return `404` and
  authenticated mutation APIs return `403`.
- Consume and remove `RATEL_API_KEY` from the daemon process environment even
  when the feature is disabled, so gateway or MCP subprocesses cannot inherit
  it accidentally.
- Persist only enabled feature flags into generated macOS launchd and Linux
  systemd service definitions. Enabling or disabling an existing background
  service requires reinstalling its service definition; a plain restart does
  not reinterpret the invoking shell's environment.
- Fail open at the telemetry boundary. Invalid persisted Cloud settings and
  invalid Cloud environment options are logged with no credential value and
  ignored independently, so another valid source can still configure the
  relay. Ratel telemetry-provider initialization failures disable runtime export
  without disabling the opaque agent relay. None of these failures prevents the
  daemon UI, MCP endpoint, or gateway from starting.
- Keep native exporter setup off until explicitly requested after the daemon
  feature is enabled. Managed Claude levels explicitly write
  `OTEL_LOG_RAW_API_BODIES=0`; a nonzero or file-backed raw-body setting is
  reported as custom sensitive configuration rather than Redacted.

This supersedes ADR 0015's decisions to keep relay routes always mounted and to
use configured Cloud settings as the only activation boundary. ADR 0015's
credential storage and authenticated settings API decisions remain in force.
It also constrains the setup surfaces from ADRs 0016 and 0017 without changing
their exporter ownership or consent models.

## Consequences

- Experimental Cloud telemetry ships dark and cannot become active solely
  because credentials survived an upgrade.
- Operators have one stable rollback control, at the cost of reinstalling a
  background service when its persisted startup environment must change.
- Local MCP availability no longer depends on optional Cloud settings or
  telemetry-provider initialization.
- Feature status is visible to CLI and UI clients, while the credential remains
  daemon-owned and absent from status responses, native-agent configuration,
  logs, and subprocess environments.
