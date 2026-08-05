# Experimental Cloud OTLP traces

Ratel Local can relay native Claude Code and Codex OpenTelemetry traces through
its per-user daemon. The agent exporter sends OTLP/HTTP protobuf to loopback;
the daemon adds its Ratel Cloud credential and forwards the bytes unchanged.

The same opt-in also initializes the Ratel SDK's OTLP provider inside the
daemon-hosted gateway. Ratel runtime spans are sent directly to the configured
Cloud trace endpoint as `service.name=ratel-local`. These are two independent
trace streams; this iteration does not merge or correlate their trace IDs.

The relay is experimental and off by default. Configure these values only in
the daemon process environment, preferably through a local secret manager or
service-manager secret injection:

```text
RATEL_EXPERIMENTAL_CLOUD_OTLP_RELAY=1
RATEL_CLOUD_OTLP_TRACES_ENDPOINT=https://<ratel-cloud-host>/<trace-path>
RATEL_API_KEY=<daemon-only BYOK credential>
```

Do not put `RATEL_API_KEY` in a project file, Ratel layered config, Codex
config, Claude Code config, or exporter headers. The current setup and link
flows do not write any of these values. A foreground daemon inherits the shell
environment; an installed daemon must receive them from its service environment
before it starts.

At startup, the daemon consumes `RATEL_API_KEY` into the relay and removes it
from its process environment. This prevents MCP and agent subprocesses launched
later by the daemon from inheriting the Cloud credential.

The daemon also passes the endpoint and key in memory to the Ratel SDK telemetry
provider and flushes that provider during graceful shutdown. The thin stdio
connector does not hold the credential or run the exporter.

## Exporter contract

Point the native trace exporter at:

```text
http://127.0.0.1:<daemon-port>/otlp/v1/traces
```

- Protocol: OTLP over HTTP/protobuf.
- Method: `POST`.
- Content type: `application/x-protobuf` (parameters are accepted).
- Local authorization: none in this initial loopback-only version.
- Maximum request body: 4 MiB.
- Cloud request timeout: 10 seconds.

The daemon listens on `127.0.0.1` and applies its existing loopback `Host`
validation before the trace route. The route is not mounted when the feature
flag is off.

## Relay behavior

The daemon does not parse the protobuf payload. It drops caller headers,
forwards the body to the configured HTTPS endpoint, and sets:

```text
Authorization: Bearer <daemon-held Cloud API key>
Content-Type: application/x-protobuf
```

Successful Cloud responses retain their status and protobuf body. Cloud 4xx or
5xx responses retain their status and a valid `Retry-After` header, but their
body is replaced with a fixed message. A network failure returns `502`; a
timeout returns `504`. Empty bodies, wrong methods, wrong content types, and
oversized bodies are rejected locally.

Malformed non-empty protobuf is intentionally not decoded or filtered locally;
Ratel Cloud validates it. There is no retry queue, durable spool, trace merging,
correlation, filtering, enrichment, metrics ingestion, or logs ingestion in
this iteration.

## Independent Ratel runtime export

The daemon's Ratel SDK spans use the same Cloud endpoint and credential but do
not travel through the loopback route:

```text
Claude Code / Codex traces -> daemon loopback relay -> Ratel Cloud
Ratel SDK runtime spans    -> daemon OTLP exporter  -> Ratel Cloud
```

The runtime stream includes the spans already emitted by `@ratel-ai/sdk`, such
as capability search, skill load, upstream registration, tool execution, and
authentication activity. No additional correlation or payload processing is
added by Ratel Local.

See [ADR 0013](adr/0013-daemon-owned-cloud-otlp-trace-relay.md) for the native
agent relay and
[ADR 0014](adr/0014-daemon-owned-ratel-runtime-cloud-traces.md) for the
independent daemon runtime exporter.
