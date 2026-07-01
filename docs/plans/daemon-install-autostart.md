# Plan: Daemon Install and Autostart

## Context

The `dev/deamon` branch already has a foreground daemon entrypoint that starts one Ratel gateway, serves the browser UI, and exposes the MCP streamable HTTP endpoint at `/mcp`.

The next approachable step is to make that daemon durable:

- it should have a stable local MCP URL that agent/plugin configuration can point to;
- it should be installable as a login/startup service;
- it should have basic lifecycle commands so users can inspect and repair it without understanding the host OS service manager.

This plan intentionally does not solve per-project scoping or session visualization. Those need a follow-up proxy/session model once the daemon is stable.

## Goals

- Add a stable default loopback endpoint for the daemon.
- Add `ratel-local daemon install` for login/startup registration.
- Add lifecycle commands: `status`, `start`, `stop`, `restart`, `uninstall`.
- Persist enough daemon state for the CLI and UI to find the running service.
- Keep the first implementation macOS-focused, with a service abstraction that can support Linux and Windows later.
- Make the plugin/agent future path obvious: a stable URL or a stdio proxy can connect to the daemon instead of starting a separate Ratel server.

## Non-Goals

- Do not redesign scope resolution in this task.
- Do not replace the plugin `.mcp.json` yet.
- Do not build the sessions UI yet.
- Do not add a native desktop app or tray app.
- Do not require elevated/root service installation.

## Proposed CLI

```bash
ratel-local daemon run
ratel-local daemon install
ratel-local daemon uninstall
ratel-local daemon status
ratel-local daemon start
ratel-local daemon stop
ratel-local daemon restart
ratel-local daemon open
```

`daemon run` is the foreground command used by the service manager. Existing `ratel-local daemon` behavior can either become an alias for `daemon run` or remain supported for compatibility.

`daemon open` opens the UI for the currently running daemon, similar to Executor's `executor web`.

## Endpoint Strategy

Use a stable default port:

```text
UI:  http://127.0.0.1:5731
MCP: http://127.0.0.1:5731/mcp
```

If the default port is busy, first implementation should fail clearly instead of silently choosing a random port. A random fallback makes static plugin/client configuration unreliable.

Future improvement: allow a persisted alternate port in `~/.ratel/daemon.json`, but only if `ratel-local daemon install --port <n>` and `ratel-local mcp link` can keep client configuration in sync.

## State Files

Persist daemon metadata under:

```text
~/.ratel/daemon.json
~/.ratel/logs/daemon.log
~/.ratel/logs/daemon.err.log
```

Suggested `daemon.json` shape:

```json
{
  "pid": 12345,
  "port": 5731,
  "uiUrl": "http://127.0.0.1:5731",
  "mcpUrl": "http://127.0.0.1:5731/mcp",
  "startedAt": "2026-07-01T08:00:00.000Z",
  "version": "0.3.0-rc.0",
  "configMode": "auto"
}
```

This file is advisory. `status` must verify liveness by probing the HTTP server, not only by trusting the PID.

## Health Endpoints

Add unauthenticated loopback-only endpoints:

```text
GET /healthz
GET /api/daemon/status
```

`/healthz` should be minimal and suitable for CLI/service checks.

`/api/daemon/status` can include version, uptime, port, MCP URL, UI URL, configured upstream count, and active client/session counts.

Keep protected UI APIs behind the existing session token.

## macOS Install

Implement a `launchd` user agent.

Plist path:

```text
~/Library/LaunchAgents/ai.ratel.local.daemon.plist
```

Program arguments:

```text
ratel-local daemon run --port 5731 --no-open --auto-config
```

Important plist settings:

- `RunAtLoad`: true
- `KeepAlive`: true
- `StandardOutPath`: `~/.ratel/logs/daemon.log`
- `StandardErrorPath`: `~/.ratel/logs/daemon.err.log`
- working directory: user's home directory

`install` should:

1. Resolve the current `ratel-local` executable path.
2. Create `~/.ratel/logs`.
3. Write the LaunchAgent plist.
4. Run `launchctl bootstrap gui/$UID <plist>`.
5. Run `launchctl kickstart -k gui/$UID/ai.ratel.local.daemon`.
6. Probe `/healthz`.
7. Print the UI and MCP URLs.

`uninstall` should:

1. Run `launchctl bootout gui/$UID <plist>` if loaded.
2. Remove the plist.
3. Leave `~/.ratel/config.json`, logs, OAuth tokens, backups, and skills intact.

## Linux Install

Add after macOS is working.

Use a user-level systemd unit:

```text
~/.config/systemd/user/ratel-local-daemon.service
```

Lifecycle commands should wrap:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ratel-local-daemon.service
systemctl --user status ratel-local-daemon.service
systemctl --user stop ratel-local-daemon.service
systemctl --user disable ratel-local-daemon.service
```

Support Linux only when `systemctl --user` is available. Otherwise print a manual foreground command.

## Windows Install

Defer unless needed for release.

Likely options:

- Task Scheduler entry at user login.
- A lightweight service wrapper.

For the first pass, `install` on Windows can return a clear "not implemented yet" message while `daemon run` remains available.

## Implementation Steps

1. Extend arg parsing to support daemon verbs.
2. Split daemon foreground runtime into `runDaemonServer` and CLI lifecycle handlers.
3. Add stable default port handling.
4. Add daemon state writer and liveness probe.
5. Add `/healthz` and `/api/daemon/status`.
6. Add macOS LaunchAgent installer/uninstaller.
7. Add `status`, `start`, `stop`, `restart`, and `open`.
8. Update README/plugin docs with the new local-daemon flow.
9. Add focused tests for arg parsing, plist generation, status probing, and daemon state.

## Testing Plan

Unit tests:

- daemon verb parsing;
- default port resolution;
- daemon state JSON generation;
- LaunchAgent plist generation;
- status behavior for running, stopped, stale PID, and port occupied cases.

Integration tests:

- foreground daemon serves `/healthz`;
- foreground daemon serves `/mcp`;
- UI API can report daemon status;
- MCP client can connect to stable `/mcp`.

Manual macOS test:

```bash
pnpm --filter @ratel-ai/ratel-local build
ratel-local daemon install
ratel-local daemon status
open http://127.0.0.1:5731
ratel-local daemon restart
ratel-local daemon uninstall
```

## Open Questions

- Should `ratel-local daemon` with no verb continue to run foreground for compatibility, or should it print help?
- Should the stable port be `5731`, or should we choose a different reserved-ish project port?
- Should `install` require `--auto-config`, or should the daemon start with user config only until the proxy/scope work lands?
- Should the daemon UI token be persisted for browser reopen, or should `daemon open` mint/proxy a fresh UI session token?

## Recommended First Slice

Implement macOS-only install/status around the existing daemon runtime:

- `daemon run`
- `daemon install`
- `daemon uninstall`
- `daemon status`
- stable port `5731`
- `/healthz`
- `~/.ratel/daemon.json`

That slice gives us the durable local endpoint needed for the plugin/proxy discussion without forcing the harder scope/session decisions into the same PR.
