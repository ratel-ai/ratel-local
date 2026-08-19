# 15. Persisted Cloud trace settings and always-available relay

Date: 2026-08-05

## Status

Accepted

## Context

ADR 0013 introduced an environment-gated loopback relay, and ADR 0014 sent
daemon-hosted Ratel SDK spans directly to Cloud. Testing confirmed both trace
sources, but requiring service-manager environment injection makes the
installed background daemon awkward to configure. Direct SDK export also
makes a runtime credential change harder to apply without replacing the global
OpenTelemetry provider.

The Cloud integration already remains inactive without an endpoint and API key,
so an additional experimental route flag does not provide useful protection.

## Decision

- Keep `POST /otlp/v1/traces` mounted on the loopback daemon without a feature
  flag. Return `503` until Cloud settings are available.
- Add a Ratel Cloud section to the UI's renamed Settings page. Its authenticated
  `GET /api/cloud-traces` response exposes only `configured` and `endpoint`.
  `PATCH /api/cloud-traces` accepts an HTTPS endpoint and an API key; omitting a
  key preserves the existing one.
- Persist the endpoint and API key in `~/.ratel/cloud-traces.json` using an
  atomic write, a user-only directory, and a user-only file. This is deliberately
  a simple daemon-owned settings file, not a keychain or encrypted vault.
- Load the persisted settings for foreground and installed background daemon
  starts. Continue to accept `RATEL_CLOUD_OTLP_TRACES_ENDPOINT` plus
  `RATEL_API_KEY` as a current-run override, and remove the key from the process
  environment after reading it.
- Apply saved settings to the in-memory relay immediately. Initialize the Ratel
  SDK telemetry provider once against the daemon's own loopback OTLP endpoint,
  so runtime spans and native-agent traces share credential injection and
  upstream handling without merging their traces.
- Keep the relay deliberately opaque: do not add payload filtering, redaction,
  enrichment, correlation, retries, or durable buffering.

This decision supersedes ADR 0013's feature flag and environment-only setup,
and ADR 0014's direct daemon-to-Cloud SDK export. Their remaining transport and
ownership decisions still apply.

## Consequences

- A user can configure Cloud once in the daemon UI and an installed daemon will
  use it on later starts without service environment variables.
- Credential changes take effect for relay forwarding without restarting the
  daemon. The SDK provider remains installed once because it targets the stable
  loopback relay.
- The API key remains daemon-owned and is not returned to the browser or placed
  in native exporter configuration, though it is stored as plain JSON readable
  by the local user.
- The OTLP endpoint exists before setup, but cannot forward and returns `503`.
- Native-agent and Ratel runtime spans remain separate trace streams.
