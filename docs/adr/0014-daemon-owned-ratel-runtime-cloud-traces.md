# 14. Daemon-owned Ratel runtime Cloud traces

Date: 2026-08-05

## Status

Accepted

## Context

[ADR 0013](0013-daemon-owned-cloud-otlp-trace-relay.md) added a loopback
OTLP/HTTP relay for native Claude Code and Codex traces. Ratel Local's gateway
also emits `ratel.*` and `gen_ai.*`
OpenTelemetry spans through `@ratel-ai/sdk`, but those spans remain no-ops until
the host process installs an OpenTelemetry provider.

The daemon hosts the gateway runtime and already owns the Cloud endpoint and
credential needed by the relay. The short-term goal is to deliver both trace
streams without attempting to merge or correlate them.

## Decision

- When the experimental Cloud OTLP relay is enabled, initialize the Ratel SDK's
  OTLP telemetry provider once in the daemon process.
- Use the same daemon-held Cloud trace endpoint and API key, passed explicitly
  in memory to `@ratel-ai/sdk`'s `configureTelemetry()` API. Keep
  `RATEL_API_KEY` removed from the daemon environment before gateway or MCP
  subprocesses can inherit it.
- Export Ratel runtime spans directly from the daemon to the configured Cloud
  trace endpoint with `service.name=ratel-local`.
- Keep native-agent traces on the opaque loopback relay path from ADR 0013.
  The two exporters produce independent trace streams and may use unrelated
  trace IDs.
- Flush and shut down the Ratel telemetry provider after MCP and gateway
  shutdown so completed runtime spans are exported.
- Do not add trace merging, correlation, rewriting, a queue, or a second
  configuration surface in this iteration.

## Consequences

- Ratel searches, skill loads, upstream registration, tool execution, and auth
  spans emitted by the SDK become visible in Cloud alongside native-agent
  traces.
- The thin stdio connector remains uninstrumented by this exporter; the spans
  originate in the daemon process where gateway work executes.
- Enabling the existing experimental relay flag enables both independent Cloud
  trace paths. When it is off, the daemon installs no Ratel-owned telemetry
  provider.
- Correlation and shared trace parenting remain follow-up work.
