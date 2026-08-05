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

Agent Setup also offers an inline API-key prompt whenever native tracing is
enabled but Ratel Cloud is not configured. It reuses the daemon's Cloud
endpoint, so only the API key is requested. Create a key at
<https://cloud.ratel.sh/settings> if needed.

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

## Configure native agent exporters

Use the Agent Setup page or the CLI. Do not edit the native config files by
hand:

```bash
ratel-local traces status
ratel-local traces status --agent codex --json
ratel-local traces enable --agent claude-code --agent codex
ratel-local traces disable --agent codex
```

Status reports `disabled`, `configured`, `stale`, `conflict`, or `invalid` for
each host. Ratel safely repairs a stale loopback endpoint from an older daemon
port. It does not replace an unrelated exporter by default. Interactive
overwrite explains that no backup is retained; automation must use both
`--overwrite` and `--yes`.

After an interactive enable, the CLI offers to configure Ratel Cloud when it is
missing. The API key is entered through a masked prompt and saved immediately by
the daemon. `--yes` remains non-interactive: it does not request a secret and
prints <https://cloud.ratel.sh/settings> as the next step instead.

`ratel-local setup` offers traces as its final optional interactive step. Plain
`setup --yes` continues to skip traces. Explicit automation uses:

```bash
ratel-local setup --yes --traces --agent claude-code --agent codex
# Add only when replacing a known conflicting exporter is intentional:
ratel-local setup --yes --traces --overwrite-traces --agent codex
```

Claude Code is configured in `~/.claude/settings.json` with its native telemetry
and enhanced-telemetry beta selectors, trace-only OTLP/HTTP protobuf routing,
and an empty trace-specific header. Existing log, metric, and content/privacy
flags are preserved. Codex is configured only in the user-level
`~/.codex/config.toml` with its OTLP/HTTP binary trace exporter and no headers;
unrelated tables, profiles, comments, and formatting are preserved.

The UI and CLI cannot submit another agent-exporter endpoint. The daemon derives
the loopback URL from its live port. The inline Cloud onboarding path also reads
the Cloud endpoint from the daemon rather than accepting one from the prompt.
Enabling an agent while Cloud is unconfigured remains allowed. Start a new
Claude Code or Codex session after a change.

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
[ADR 0015](adr/0015-persisted-cloud-trace-settings.md), and
[ADR 0016](adr/0016-native-agent-trace-exporter-setup.md).
