# 12. Opt-in scoped dense retrieval

Date: 2026-07-31

## Status

Accepted

Extends the scoped configuration and immutable-generation decisions in
ADR-0007, ADR-0008, and ADR-0009.

## Context

Ratel Local historically used model-free BM25 search for every tool and skill
catalog. Semantic retrieval can improve recall when a prompt and capability use
different vocabulary, while hybrid retrieval can retain lexical precision and
add semantic recall. Dense retrieval also introduces model downloads, memory
cost, remote-data-transfer choices, and startup failure modes that BM25 does
not have.

Retrieval configuration must respect the existing user, project, and local
scope model. It must not silently download a model, send tool metadata to a
remote endpoint, or mutate an active gateway generation underneath connected
clients.

## Decision

- Keep BM25 as the model-free default. Semantic and hybrid retrieval are
  explicit opt-ins at user, project, or local scope.
- Treat `retrieval` as one atomic scoped block. The narrowest scope that
  defines it replaces the complete earlier block instead of merging model or
  source fields independently.
- Support a pinned built-in model, explicit Hugging Face and local models,
  Ollama, and OpenAI-compatible embedding endpoints. Validate each source
  strictly, reject literal credentials, and reference remote bearer keys only
  through environment-variable names.
- Separate configuration from preflight. Preflight may download an explicitly
  selected model, load it, or send a representative endpoint request, and must
  disclose memory, cache, and remote-data-transfer implications.
- Fail a dense gateway build closed when its model or endpoint is unavailable.
  Do not fall back silently to BM25 because that would change requested search
  semantics without the user's knowledge.
- Include retrieval configuration in the immutable runtime revision. After a
  retrieval or dense-auth change, new sessions acquire a new generation while
  existing leases drain on their prior generation.
- Keep retrieval build health behind
  `RATEL_EXPERIMENTAL_RETRIEVAL_HEALTH=1` initially. Without the flag, daemon
  health retains its existing behavior.

## Consequences

- Existing installations remain model-free and behaviorally compatible until
  a user opts a scope into semantic or hybrid retrieval.
- Dense retrieval can improve recall, but users must choose acceptable model,
  memory, cache, language, and data-transfer tradeoffs.
- CLI and UI mutations inherit the control plane's revision checks, backups,
  journaling, and rollback behavior.
- Configuration and model preparation can succeed before a client reconnects;
  the old client continues using its immutable generation until then.
- Release validation must cover native SDK packages on every supported target
  and verify that the packed npm package does not retain workspace-only
  dependency ranges.
