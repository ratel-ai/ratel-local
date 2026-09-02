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

## Current concurrency limitation

The daemon shares one catalog generation, and therefore one online learner,
between sessions in the same project. The learner currently has one pending
search slot. Two simultaneous sessions can interleave like this:

1. Session A searches for X.
2. Session B searches for Y.
3. Session A invokes Z.

That sequence can incorrectly teach `Y -> Z`. Sequential sessions are not
affected, and separate projects use separate catalogs and graphs. Session-scoped
learners over a shared catalog are intentionally deferred from this first
version.
