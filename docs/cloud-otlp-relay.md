# Ratel Cloud OTLP telemetry relay

Ratel Local relays native Claude Code and Codex OpenTelemetry traces and logs
through its per-user daemon. Agent exporters send OTLP/HTTP protobuf to
loopback; the daemon adds its Ratel Cloud credential and forwards the bytes
unchanged. This integration is experimental and disabled by default.

The daemon-hosted gateway also initializes the Ratel SDK telemetry provider as
`service.name=ratel-local`. Its exporter sends through the same loopback relay,
so both external-agent and Ratel runtime streams use one daemon-owned endpoint
and credential. They remain independent traces; Ratel Local does not merge or
correlate their trace IDs.

## Enable the feature

Cloud telemetry is controlled by the daemon-wide environment flag
`RATEL_FEATURE_CLOUD_TELEMETRY`. Only the exact value `1` enables the feature;
an unset value, `0`, and every other value keep it off. The flag gates the
loopback relay, Cloud credential loading, Ratel SDK export, native exporter
mutations, setup prompts, and UI controls together.

For a new installation with interactive onboarding, or for a foreground daemon:

```bash
RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local setup
RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local daemon run --no-open --auto-config
```

When setup installs a macOS launchd or Linux systemd service, it copies the
enabled flag into that service definition. A later setup run does not rewrite an
already-current service. Enable, keep, or disable an existing service by making
the feature-flag variable present or absent on `daemon restart`:

```bash
# Enable — rewrites only the feature-flag environment entry
RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local daemon restart

# Keep enabled — variable absent; installed service file is preserved
ratel-local daemon restart

# Disable — any present value other than `1` removes the persisted flag
RATEL_FEATURE_CLOUD_TELEMETRY=0 ratel-local daemon restart
```

`daemon start` does not rewrite the service. Uninstall then install remains a
valid fallback and does not delete Ratel configuration or saved Cloud settings.

The startup environment is the only feature-flag source. Cloud endpoint and
credential settings do not override it, so a saved key cannot silently enable
network export after an upgrade.

## Configure Ratel Cloud

Open the daemon UI and select **Settings**. In the **Ratel Cloud** section, enter:

- Trace endpoint: `https://cloud.ratel.sh/api/v1/traces`
- API key: your `rtl_...` credential

The daemon derives the matching Cloud log route by replacing the exact terminal
`/traces` path segment with `/logs`. Saving activates both signal relays and
Ratel runtime trace export immediately. The
daemon persists the endpoint and key in `~/.ratel/cloud.json`, with the
directory and file restricted to the current user. The authenticated UI API
returns only the endpoint and whether a key is configured; it never returns
the saved key. An installed background daemon loads the same file on its next
start, so no credential environment variables are required after saving. The
relay still requires the feature flag; the credential loads without it.

The store holds named profiles, managed from the CLI:

```bash
ratel-local cloud add <profile-name>     # prompts for the key, stores it under a name
ratel-local cloud use <profile-name>     # selects it for this scope, with a backup
ratel-local cloud list         # profiles, the default, what resolves here
```

The first profile stored becomes the default, so a single-project setup never
selects anything. A project selects another with `cloud.profile` in its layered
config: a name, never a credential, and therefore safe to commit.
`RATEL_PROFILE` overrides it for a foreground daemon.

A pre-existing `~/.ratel/cloud-traces.json` becomes the `default` profile and
stays in place, so a downgrade keeps working. Once the new store is written it
stops being read while still holding a key — delete it when the downgrade path
no longer matters. See
[ADR 0021](adr/0021-cloud-project-credential-ownership.md).

Agent Setup also offers an inline API-key prompt whenever native tracing is
enabled but Ratel Cloud is not configured. It reuses the daemon's Cloud
endpoint, so only the API key is requested. Create a key at
<https://cloud.ratel.sh/settings> if needed.

For a one-run override, start the daemon with both values:

```text
RATEL_FEATURE_CLOUD_TELEMETRY=1
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
ratel-local traces enable --agent claude-code --level tool-details
ratel-local traces enable --agent codex --level tool-activity
ratel-local traces disable --agent codex
```

Both hosts support **Off** and **Redacted**. Redacted is the default for the
backward-compatible `traces enable` command. For Claude, Redacted sends traces
and structured logs with every managed content gate off, including raw API
body capture; Claude additionally
supports **Tool details** and **Full content**. For Codex, Redacted remains
traces-only; **Tool activity** adds structured logs with user prompt logging
off, and **Prompt content** additionally includes user prompts. Codex
`tool_result` records can include output snippets. Ratel does not promise
Codex assistant-response bodies or full tool arguments because Codex does not
document those fields.

Tool details, Full content, Tool activity, and Prompt content can carry
sensitive material. Interactive CLI and Agent Setup flows display a privacy
warning and require confirmation. Automation must be fully explicit:

```bash
ratel-local traces enable --agent claude-code --level full-content \
  --confirm-content --yes
```

Status reports `disabled`, `configured`, `stale`, `conflict`, or `invalid` for
each host. Ratel safely repairs a stale loopback endpoint from an older daemon
port. It does not replace an unrelated exporter by default. Interactive
overwrite explains that no backup is retained; automation must use both
`--overwrite` and `--yes`.

When Ratel Cloud is not configured, `traces enable` points at
`ratel-local cloud add <profile>` instead of prompting inline.

`ratel-local setup` offers traces as its final optional interactive step. Plain
`setup --yes` continues to skip traces. Explicit automation uses:

```bash
ratel-local setup --yes --traces --agent claude-code --agent codex
# Add only when replacing a known conflicting exporter is intentional:
ratel-local setup --yes --traces --overwrite-traces --agent codex
```

Claude Code is configured in `~/.claude/settings.json` with native telemetry,
enhanced-telemetry beta, independent trace and log OTLP/HTTP protobuf routing,
and empty signal-specific headers. Redacted explicitly disables prompt,
response, tool-detail, tool-content, and raw-API-body gates. Codex is configured in
`~/.codex/config.toml`; its trace and optional log exporters use OTLP/HTTP
binary with empty headers, and `log_user_prompt` is managed explicitly for
Ratel-owned log routing. Lowering or disabling surgically removes only exact or
stale Ratel routes and preserves unrelated exporters, tables, profiles,
comments, and formatting. Every Claude level explicitly writes
`OTEL_LOG_RAW_API_BODIES=0`; no normal level enables metrics.

The UI and CLI cannot submit another agent-exporter endpoint. The daemon derives
the loopback URL from its live port. The inline Cloud onboarding path also reads
the Cloud endpoint from the daemon rather than accepting one from the prompt.
Enabling an agent while Cloud is unconfigured remains allowed. Start a new
Claude Code or Codex session after a change.

## Exporter contract

Point native exporters at the signal-specific loopback routes:

```text
http://127.0.0.1:<daemon-port>/otlp/v1/traces
http://127.0.0.1:<daemon-port>/otlp/v1/logs
```

- Protocol: OTLP over HTTP/protobuf.
- Method: `POST`.
- Content type: `application/x-protobuf` (parameters are accepted).
- Local authorization: none in this initial loopback-only version.
- Maximum request body: 4 MiB.
- Cloud request timeout: 10 seconds.

The daemon listens on `127.0.0.1` and applies its existing loopback `Host`
validation before either route. The routes are mounted only while the feature
flag is enabled; once mounted, they return `503` until Cloud settings are
configured.

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

Cloud settings parse failures and Ratel SDK telemetry-provider initialization
failures are logged and disable the affected export path without preventing the
Local daemon, UI, or MCP gateway from starting.

Malformed non-empty protobuf is intentionally not decoded or filtered locally;
Ratel Cloud validates it. There is no retry queue, durable spool, local
trace/log joining, correlation, filtering, enrichment, or metrics ingestion.
Cloud-side acceptance, normalization, persistence, and joining of native log
events are separate from this relay.

```text
Claude Code / Codex traces -> daemon loopback trace relay -> Ratel Cloud
Claude Code / Codex logs   -> daemon loopback log relay   -> Ratel Cloud
Ratel SDK runtime spans    -> daemon loopback trace relay -> Ratel Cloud
```

The runtime stream includes spans already emitted by `@ratel-ai/sdk`, such as
capability search, skill load, upstream registration, tool execution, and
authentication activity. The thin stdio connector does not own the exporter.

See [ADR 0013](adr/0013-daemon-owned-cloud-otlp-trace-relay.md),
[ADR 0014](adr/0014-daemon-owned-ratel-runtime-cloud-traces.md),
[ADR 0015](adr/0015-persisted-cloud-trace-settings.md),
[ADR 0016](adr/0016-native-agent-trace-exporter-setup.md), and
[ADR 0017](adr/0017-host-aware-native-trace-detail-levels.md).
