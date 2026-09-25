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

Ratel Local pins SDK `0.13.0-rc.5`, which keys pending online-learning state by
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

MCP does not provide a user-turn boundary here, so the correlation scope is the
connection, not an individual user message. Within one connection, searches and
invocations still follow the SDK's latest-search pairing rules. Independent
parallel agents must use separate MCP connections. Learned graph history remains
shared within the runtime context so subsequent sessions benefit from it.
