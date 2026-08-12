# 17. Host-aware native telemetry detail levels and OTLP log relay

Date: 2026-08-12

## Status

Accepted

## Context

ADR 0016 added one opt-in native trace exporter switch for Claude Code and
Codex. The hosts expose different OTel signals and content controls. Claude can
emit traces and structured logs, with independent prompt, response, tool-detail,
and trace-event tool-content gates. Codex has no general trace-detail control,
but it can emit structured OTel logs; `otel.log_user_prompt` controls user prompt
content and `codex.tool_result` records can contain an output snippet.

A symmetric selector would misrepresent these capabilities. Content-bearing
levels also need stronger consent without weakening exporter ownership,
stale-port repair, atomic mutation, restart, or secret-free preview guarantees.

## Decision

- Add an opaque daemon loopback log relay at `/otlp/v1/logs`. It shares the trace
  relay's credential boundary, validation, limits, timeout, and sanitized
  responses. It derives the Cloud log URL by replacing an exact terminal
  `/traces` path segment with `/logs`; no second credential or persisted endpoint
  is added.
- Preserve OTLP protobuf request bytes unchanged. Cloud acceptance,
  normalization, persistence, and trace/log joining remain Cloud concerns.
- Model host-aware levels. Claude supports `off`, `redacted`, `tool-details`, and
  `full-content`. Codex supports `off`, `redacted`, `tool-activity`, and
  `prompt-content`.
- Claude Redacted routes traces and structured logs with prompt, response, tool
  detail, and tool-content gates off. Tool details enables tool parameters and
  arguments while prompt and response content remain off. Full content enables
  all four managed gates.
- Codex Redacted remains the backward-compatible traces-only level. Tool
  activity additionally routes structured logs with `log_user_prompt=false`;
  tool-result records can contain output snippets. Prompt content additionally
  sets `log_user_prompt=true`. Do not promise assistant response bodies or full
  tool arguments, which Codex does not document.
- Keep `ratel-local traces enable`, setup `--traces`, and enable API requests
  without a level mapped to Redacted. Export remains off until explicitly
  enabled. Claude's Redacted level now additively includes redacted structured
  logs; Codex Redacted remains trace-only.
- Require interactive confirmation for every content-bearing level. Automation
  must explicitly name the level and pass both `--yes` and
  `--confirm-content`.
- Manage trace and log ownership independently. Lowering or disabling removes
  only exact or stale Ratel loopback routes and Ratel-owned content gates;
  unrelated exporters are preserved. Targeted conflict approval is required
  only for signals the selected level would replace.
- Never configure metrics or `OTEL_LOG_RAW_API_BODIES`. Agent exporters use
  signal-specific empty headers so the Cloud key remains daemon-only.
- Extend authenticated status, prepare requests, and secret-free previews
  additively with levels, per-signal state, and the derived loopback log URL.

This extends ADR 0016. Its atomicity, overwrite, restart, and secret-handling
decisions remain in force.

## Consequences

- The UI and CLI expose only controls that materially affect signals Ratel can
  receive.
- Existing callers stay on the safest host-specific level and no migration
  writes occur until a user opts in or reapplies a stale configuration.
- Existing Claude trace-only Redacted configurations inspect as stale so users
  can explicitly repair them to add redacted logs.
- Cloud must accept and normalize native Claude and Codex log records before all
  events become visible in Ratel's trace experience.
