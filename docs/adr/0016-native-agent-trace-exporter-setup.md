# 16. Native agent trace exporter setup

Date: 2026-08-05

## Status

Accepted

## Context

The daemon-owned OTLP relay keeps the Ratel Cloud credential out of Claude Code
and Codex, but users still have to configure each native exporter correctly.
Manual editing is error-prone: a generic OTLP header can accidentally forward a
credential to loopback, Codex ignores project-level telemetry routing, and a
daemon port change can leave an otherwise Ratel-owned exporter stale.

Exporter setup crosses two user-owned configuration files, so it also needs the
same atomicity and conflict discipline as the rest of the Ratel control plane.

## Decision

- Add a dedicated `agent-traces` core control plane, separate from MCP host
  adapters and Cloud settings. Host codecs receive only a validated
  `LoopbackTraceEndpoint` derived from the daemon's live bound port.
- Inspect and surgically rewrite only native trace routing in Claude Code user
  settings and the Codex user config. Do not configure logs, metrics, or content
  collection. Never write Codex telemetry routing to a project config.
- Clear trace-specific headers when enabling. Agent configuration contains only
  the loopback trace endpoint, protocol, and exporter selectors; the Cloud key
  remains daemon-owned.
- Classify each host as `disabled`, `configured`, `stale`, `conflict`, or
  `invalid`. A recognizable Ratel loopback endpoint on an old port is safe to
  repair. An unrelated or partially drifted exporter is a conflict.
- Prepare multi-host changes with the existing revision-checked mutation
  coordinator. Return only semantic state, field names, paths, and warnings.
  Raw configuration, headers, displaced values, and credentials are forbidden
  from API responses, previews, logs, CLI output, and UI state.
- Do not retain a persistent backup. Conflict overwrite is explicit and
  irreversible. Interactive clients confirm it; automation needs both the
  overwrite and confirmation flags.
- Disable only exact or stale Ratel routing. Set the native trace selector to
  `none`, remove Ratel-specific trace routing, and never attempt to restore an
  exporter that was replaced earlier.
- Expose authenticated status and prepare APIs, the `ratel-local traces` CLI,
  an optional final setup step, and per-agent UI controls. Exporters remain
  disabled until the user opts in. A new agent session is required after a
  persisted change.

This supersedes ADR 0013's decision to omit automatic exporter configuration
and setup UI. ADR 0013's relay transport and credential boundaries, as amended
by ADR 0015, remain in force.

## Consequences

- Claude Code and Codex share one safe setup surface without sharing config
  codecs with Cloud credential types.
- Stale daemon ports are repaired without granting arbitrary endpoint writes to
  the browser or CLI.
- Conflicting exporter replacement is intentionally lossy and cannot be undone
  through Ratel.
- Persisted configuration reports readiness, not live host-process state;
  managed policy or launch-time environment overrides may still win.
- Cloud setup is independent. Enabling before Cloud configuration is allowed,
  and the relay returns `503` until Cloud is ready.
