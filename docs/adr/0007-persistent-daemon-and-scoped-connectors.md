# 7. Persistent daemon and scoped connectors

Date: 2026-07-24

## Status

Accepted

## Context

Starting a complete gateway in every agent process duplicates upstream
connections and prevents one UI from showing the state of all local sessions.
A single static daemon gateway is also insufficient: user, project, and local
configuration must remain isolated, and project identity cannot depend on the
agent's transient working-directory spelling.

The plugin still needs an MCP stdio process because agent hosts manage that
transport directly. The process must remain useful when the background service
is stopped or not yet installed.

## Decision

- Run one per-user Ratel Local daemon as a macOS launch agent or Linux systemd
  user service. Foreground operation remains available for development and
  unsupported service managers.
- Bind the daemon to loopback and use a stable install-time port. Reject port
  zero for login services and fail installation when the selected port is
  occupied.
- Identify readiness through the daemon status protocol, including a product
  marker, protocol version, and package version; do not accept an arbitrary
  successful HTTP health response as the installed service.
- Keep the plugin MCP definition as a lightweight stdio connector. It sends the
  canonicalizable project root and agent metadata to the daemon and proxies MCP
  requests and list-change notifications.
- Authenticate connector and CLI daemon requests with a per-user daemon token.
  Browser access uses short-lived in-memory UI session tokens minted through an
  authenticated loopback exchange.
- Resolve each connection to a global or canonical project context. Share a
  gateway only between sessions with the same context and runtime revision.
- Treat gateway generations as immutable after configuration changes. New
  sessions acquire the new generation; existing sessions are marked stale
  until they reconnect. OAuth authorization is the exception: run it through
  the active shared generation so the catalog can add the authenticated
  upstream and notify connected clients immediately.
- When the daemon is unavailable, keep the connector alive with only daemon
  status, start, and setup-guidance tools.

## Consequences

- Upstream processes and connections are reused without leaking project-local
  configuration across repositories.
- Agent installation is stable even while the daemon is restarted or upgraded.
- Configuration changes do not mutate catalogs underneath in-flight requests,
  but clients may need to reconnect when the UI marks their generation stale.
- OAuth completed through the CLI, UI, or MCP auth tool updates the same live
  generation.
- The daemon token and UI session URLs are credentials and must not be written
  to persistent service logs.
- Connector and daemon protocol/version compatibility is now part of the
  release surface.
