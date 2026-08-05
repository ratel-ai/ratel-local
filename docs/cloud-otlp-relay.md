# Ratel Cloud OTLP traces

Ratel Local relays native Claude Code and Codex OpenTelemetry traces through
its per-user daemon. The agent exporter sends OTLP/HTTP protobuf to loopback;
the daemon adds its Ratel Cloud credential and forwards the bytes unchanged.

The daemon-hosted gateway also initializes the Ratel SDK telemetry provider as
`service.name=ratel-local`. Its exporter sends through the same loopback relay,
so both external-agent and Ratel runtime streams use one daemon-owned endpoint
and credential. They remain independent traces; Ratel Local does not merge or
correlate their trace IDs.

## Configure Ratel Cloud

Open the daemon UI and select **Settings**. In the **Ratel Cloud** section, enter:

- Trace endpoint: `https://cloud.ratel.sh/api/v1/traces`
- API key: your `rtl_...` credential

Saving activates both the relay and Ratel runtime export immediately. The
daemon persists the endpoint and key in `~/.ratel/cloud-traces.json`, with the
directory and file restricted to the current user. The authenticated UI API
returns only the endpoint and whether a key is configured; it never returns
the saved key. An installed background daemon loads the same file on its next
start, so no service environment variables are required after saving.

For a one-run override, start the daemon with both values:

```text
RATEL_CLOUD_OTLP_TRACES_ENDPOINT=https://cloud.ratel.sh/api/v1/traces
RATEL_API_KEY=<daemon-only BYOK credential>
```

The environment pair overrides saved settings for that daemon run and is not
written automatically. At startup, the daemon consumes `RATEL_API_KEY` and
removes it from its process environment before it can launch subprocesses.

Do not put `RATEL_API_KEY` in a project file, Codex config, Claude Code config,
or exporter headers. Native exporters need only the loopback URL.

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
validation before the trace route. The route is always available; it returns
`503` until Cloud settings are configured.

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

```text
Claude Code / Codex traces -> daemon loopback relay -> Ratel Cloud
Ratel SDK runtime spans    -> daemon loopback relay -> Ratel Cloud
```

The runtime stream includes spans already emitted by `@ratel-ai/sdk`, such as
capability search, skill load, upstream registration, tool execution, and
authentication activity. The thin stdio connector does not own the exporter.

See [ADR 0013](adr/0013-daemon-owned-cloud-otlp-trace-relay.md),
[ADR 0014](adr/0014-daemon-owned-ratel-runtime-cloud-traces.md), and
[ADR 0015](adr/0015-persisted-cloud-trace-settings.md).
