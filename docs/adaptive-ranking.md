# Adaptive ranking

Ratel Local can opt into the SDK's experimental online adaptive ranking. The
daemon observes a capability search followed by a tool or skill invocation and
uses that evidence to refine future searches.

## Enable the feature

Only the exact value `1` enables the daemon-wide feature:

```bash
# Foreground daemon
RATEL_FEATURE_ADAPTIVE_RANKING=1 ratel-local daemon run --no-open --auto-config

# Existing launchd or systemd installation
RATEL_FEATURE_ADAPTIVE_RANKING=1 ratel-local daemon restart
```

Set the value to `0` on `daemon restart` to remove it from the installed
service. Omitting the variable leaves the installed service unchanged.

## Scope and persistence

The daemon owns one in-memory intent graph for each runtime context:

- Global: `~/.ratel/adaptive-ranking/global.json`
- Project: `~/.ratel/adaptive-ranking/projects/<projectId>.json`

Each context's tool and skill catalogs receive the same graph. Project graphs
do not affect other projects or the global catalog. New gateway generations for
the same context continue using the existing graph.

Changed graphs are written atomically every five seconds and once more during
orderly daemon shutdown. Directories use mode `0700` and graph files use mode
`0600`. A malformed or unsupported saved graph is logged and ignored so it
cannot prevent the gateway from starting. If the file advances beyond the
revision loaded by this daemon, Ratel Local preserves the newer file instead of
overwriting it from a stale in-memory graph.

The graph contains raw search queries. Treat it as sensitive local telemetry and
do not commit, copy into images, or move it to a less trusted store.

## Retrieval model

Adaptive ranking uses the catalog's existing retrieval configuration. BM25
requires no model. Semantic and hybrid catalogs use their configured embedding
model for intent matching. If that model changes, the SDK pauses the adaptive
arm and emits its model-mismatch warning; the underlying catalog retrieval
continues to work.

## Session isolation

Ratel Local pins SDK `0.13.0-rc.10`, which keys pending online-learning state by
`turnId`. Each MCP server connection generates a unique correlation ID and passes
it to the SDK for `search_capabilities`, `invoke_tool`, and `get_skill_content`.
The ID stays stable for the connection, including when tool and skill catalogs
share a graph. It is independent of client names, request IDs, and the catalog's
telemetry session ID.

If session A searches for X, session B searches for Y, and A invokes Z, the
learner now pairs X with Z. Session B's search remains available for B's own
invocation. A reconnect generates a fresh ID and cannot consume the previous
connection's pending search. Both HTTP daemon sessions and direct stdio servers
use this boundary; no client changes or new tool arguments are required.

MCP does not provide a user-turn boundary here, so by default the correlation
scope is the connection, not an individual user message. Within one connection,
an invoke is credited to the newest search that offered the invoked capability,
so two searches before an invoke no longer hand the earlier query's evidence to
the later one. Independent parallel agents must use separate MCP connections.
Learned graph history remains shared within the runtime context so subsequent
sessions benefit from it.

## Per-turn correlation (experimental)

A second, off-by-default flag narrows pairing from the connection to the host's
own user turn:

```bash
RATEL_FEATURE_ADAPTIVE_RANKING=1 RATEL_FEATURE_ADAPTIVE_RANKING_PER_TURN=1 ratel daemon restart
```

When it is on, a gateway call may carry a reserved top-level argument with the
host's native ids:

```json
{ "query": "why is the build broken", "_ratel": { "session": "…", "turn": "…", "agent": "…" } }
```

The two hosts supply these ids:

- **Claude Code:** `session_id`, `prompt_id`, and `agent_id` inside a subagent.
- **Codex:** `session_id`, `turn_id`, and the subagent's id.

Ratel turns them into one SDK turn id. A search then pairs only with invokes from
the same host turn, even across an MCP reconnect, and subagents stay apart from
the main thread and from each other. A call without a valid `_ratel` keeps
per-connection pairing.

Ratel always removes `_ratel` before a tool runs, whether the flag is on or off,
so upstream servers never receive it. It is not part of any tool's input schema.
The shipped plugin does not send it yet: host hook wiring is a separate change.
The [spike](spikes/adaptive-ranking-per-turn.md) records how each host behaves,
and [ADR 0023](adr/0023-host-turn-correlation.md) records the design.
