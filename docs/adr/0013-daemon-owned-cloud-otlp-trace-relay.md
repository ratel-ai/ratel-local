# 13. Daemon-owned Cloud OTLP trace relay

Date: 2026-07-31

## Status

Accepted

## Context

Claude Code and Codex can emit traces through native OpenTelemetry exporters.
Sending those exporters directly to Ratel Cloud would require putting the Cloud
credential in each agent's configuration or process environment. Ratel Local
already has a per-user daemon bound to loopback, so it can keep the Cloud
credential inside the daemon while presenting one local OTLP endpoint to agent
exporters.

This first integration needs a small, reversible transport slice. It does not
need local trace interpretation, correlation, privacy filtering, or offline
delivery, and those concerns should not be implied by the initial endpoint.

## Decision

- Add an experimental Cloud OTLP trace relay to the existing per-user daemon.
  It is off by default and enabled only when
  `RATEL_EXPERIMENTAL_CLOUD_OTLP_RELAY=1` is present in the daemon environment.
- Supply the Cloud trace endpoint and BYOK credential only through the daemon's
  `RATEL_CLOUD_OTLP_TRACES_ENDPOINT` and the SDK-standard `RATEL_API_KEY`
  environment values. Do not add them to layered Ratel configuration, agent
  exporter configuration, daemon state, logs, HTTP responses, or repository
  files. The endpoint must be a secret-free HTTPS URL. Consume the key into
  relay memory during startup and remove it from the daemon process environment
  before the daemon can spawn MCP or agent subprocesses.
- Expose `POST /otlp/v1/traces` on the daemon's existing `127.0.0.1` HTTP
  listener. Reuse its loopback `Host` validation. The initial route accepts only
  OTLP/HTTP protobuf (`application/x-protobuf`) and has no separate local ingest
  credential.
- Treat admitted protobuf as opaque bytes. Do not decode, enrich, filter,
  correlate, or rewrite spans. Inject `Authorization: Bearer <Cloud API key>`
  only on the upstream request and do not forward caller headers.
- Bound request bodies to 4 MiB and Cloud requests to 10 seconds. Forward
  successful protobuf responses. For upstream HTTP failures, preserve the
  status and a valid `Retry-After` value but replace the body with a fixed
  sanitized message. Return fixed `502` and `504` responses for network failures
  and timeouts.
- Do not add metrics or logs ingestion, an offline spool, retries, durable
  buffering, automatic exporter configuration, or setup UI in this iteration.

## Consequences

- The Cloud API key stays in one daemon process and native exporters need only
  know a loopback URL.
- The relay adds no local processing semantics; non-empty malformed protobuf is
  left for Ratel Cloud to validate.
- Cloud latency and availability are visible to the native exporter. Its retry
  policy remains responsible for retry behavior because the daemon has no
  queue.
- Any process running as the local user can submit trace bytes to the loopback
  endpoint. A dedicated, exporter-compatible local ingest credential can be
  added later if that trust boundary proves too broad.
- Service installations must receive the three environment values through
  their service environment or secret manager. Ratel Local does not persist the
  BYOK credential for them in this iteration.
