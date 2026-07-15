---
name: ratel-improve-tools
description: Analyze Ratel Local tool usage logs and propose improvements to the configured tool catalog. Use when the user asks to review Ratel tool usage, improve available MCP tools, audit failed or repeated tool calls, tune Ratel upstream servers, or suggest better tools based on Codex or Claude Code hook logs.
---

# Ratel Improve Tools

## Goal

Use Ratel tool usage logs to propose practical improvements to the user's MCP tool setup. Focus on what the agent actually tried to do, where tool use failed or repeated, and which upstream MCP servers or Ratel configuration changes would reduce friction.

Do not print raw log entries unless the user explicitly asks. Treat logs as private local telemetry and redact secrets, tokens, request headers, file contents, and customer data in summaries.

## Log Location

Read tool usage from:

```text
${RATEL_HOME:-$HOME/.ratel}/tool-usage/tool-usage.jsonl
```

Each line is JSON with `schemaVersion`, `timestamp`, `host`, `event`, `toolName`, optional `toolInput`, optional `outcome`, and hook payload metadata. Handle missing files, empty files, and malformed lines gracefully.

If no logs exist, say that there is no tool usage data yet and suggest enabling/trusting the Ratel Local plugin hooks, then running normal agent work before trying again.

## Analysis Workflow

1. Inspect recent logs first. Prefer a bounded window such as the last 500-2000 lines unless the user asks for a full history.
2. Parse JSONL structurally. Do not rely on ad hoc text matching when JSON parsing is available.
3. Group by `toolName`, `host`, event type, success/error signal, and repeated input patterns.
4. Compare the observed usage against configured Ratel scopes when useful:

```text
~/.ratel/config.json
<project>/.ratel/config.json
<project>/.ratel/config.local.json
```

5. Look for:

- high-frequency tools that deserve first-class upstreams, aliases, or better descriptions;
- repeated `search_tools` calls that do not lead to useful `invoke_tool` calls;
- failed or denied tool calls that indicate missing auth, missing tools, weak schemas, or bad defaults;
- direct non-Ratel Local tool usage that should be imported into Ratel;
- similar tools split across upstreams where a curated choice would reduce noise;
- workflows where a new MCP server, skill, or Ratel CLI helper would be more effective than another tool.

## Output Shape

Lead with the highest-impact recommendations. Include evidence counts and representative redacted examples, not raw logs.

For each recommendation, include:

- what to change;
- why the logs support it;
- expected agent behavior improvement;
- exact `ratel-local` command or config area to inspect when the change is actionable.

If the user asks you to implement the improvements, make the smallest safe config changes and validate with `ratel-local mcp list` or the relevant Ratel command.
