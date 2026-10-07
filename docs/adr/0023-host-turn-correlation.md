# 23. Host turn correlation for adaptive ranking

Date: 2026-10-07

## Status

Proposed

## Context

Adaptive ranking learns that a query leads to a capability by pairing a
`search_capabilities` call with the invokes that follow it. The SDK pairs by
`turnId`, and the SDK's own guidance is one id per user message. MCP has no
user-turn boundary, so `createMcpServer` mints one UUID per connection. In a long
session, a search in turn 1 can therefore pair with an unrelated invoke in turn
5, and a reconnect in the middle of a turn loses a pairing it should keep.
Omitting `turnId` is no fix: the SDK then pairs with no scope at all.

Both hosts know the real boundary and show it to hooks. Claude Code provides
`session_id` and `prompt_id`, plus `agent_id` in a subagent. Codex provides
`session_id` and `turn_id`, plus `agent_id` in a subagent. The spike
([docs/spikes/adaptive-ranking-per-turn.md](../spikes/adaptive-ranking-per-turn.md))
found:

- A `PreToolUse` hook can add a field to an MCP call's arguments with
  `updatedInput`, and the field reaches the server undeclared.
- In Claude Code this does not change permission prompts.
- Codex ignores `updatedInput` without `permissionDecision: "allow"`, and in
  `codex exec` that `allow` did not bypass a required approval.
- Claude Code subagents share the parent's `session_id` **and** `prompt_id`.
- Codex already sends `session_id`, `turn_id` and `thread_id` in every MCP
  call's `_meta["x-codex-turn-metadata"]`, with no hook.
- Every failure mode (missing, disabled, untrusted, crashing or timed-out hooks)
  leaves the call unmodified.

SDK `0.13.0-rc.10` adds a turn scope, `turn(fn, { id })` (SDK ADR 0026). It also
credits an invoke to the search that offered the capability, rather than to the
latest search in the turn.

## Decision

1. **One reserved argument.** A gateway call may carry a top-level
   `_ratel: { session, turn, agent? }` with the host's native ids. Its name,
   shape, validation (non-empty strings of at most 256 characters, unknown keys
   ignored) and encoding live in one module,
   `packages/core/src/lib/turn-correlation.ts`.
2. **Always stripped.** `createMcpServer` removes `_ratel` from every gateway
   call before the tool runs, whether or not the feature is on. Nothing upstream
   ever sees it, including through `invoke_tool`'s flattened-arguments path.
3. **Behind a flag.** With `RATEL_FEATURE_ADAPTIVE_RANKING_PER_TURN=1`, a valid
   field becomes the SDK turn id
   `rt1:<session>:<turn>[:<agent>]`. Each component is percent-encoded, so the
   `:` separator cannot occur inside one and the encoding is injective. The
   component count tells the main thread from a subagent, and every agent in
   one host turn shares a prefix. Otherwise, with the flag off or the field
   absent or malformed, the per-connection UUID stays.
4. **Not declared** in any `inputSchema`. Neither host needs it, and declaring
   it would invite the model to fill it in.
5. **Explicit `turnId`, not the SDK turn scope.** Bump to `0.13.0-rc.10` for
   its attribution fix, and keep passing the id to `tool.execute(args, undefined,
   turnId)`. Reasons:
   - The fallback has no real turn. Wrapping a connection in `turn()` would emit
     a `turn_start` per connection and present a connection to Ratel Cloud as a
     turn. An explicit id serves both paths with one mechanism.
   - An explicit `turnId` already wins over a scope, and the gateway tools
     already thread it to every search and invoke.
   - A scope's extras (`turn_start`, `end_user_id`, `userMessage`) are Cloud
     telemetry, behind their own flag and consent. Adopting them later is a
     wrap around `execute`, applied only when the composite id exists.
6. **Host wiring** is a separate change and follows the spike:
   - **Claude Code:** a fail-open `PreToolUse` hook, matched only to
     `search_capabilities`, `invoke_tool` and `get_skill_content` under both
     plugin and user server names. It returns `updatedInput` =
     `{ ...tool_input, _ratel }` with no `permissionDecision`, and overwrites a
     model-supplied value.
   - **Codex:** the server reads `_meta["x-codex-turn-metadata"]`, taking only
     `session_id`, `turn_id`, and `thread_id` as the agent when
     `parent_thread_id` is present. A hook with `allow` is the fallback, only
     after the interactive approval flow is verified.

## Consequences

- With a host supplying ids, a search pairs only with invokes from the same host
  turn, across reconnects. Subagents stay apart. Without ids, behaviour is
  exactly as before.
- The flag is independent of `RATEL_FEATURE_ADAPTIVE_RANKING`. On its own it
  changes only the `turn_id` stamped on trace events.
- A client that sends `_ratel` without a hook (a model, a script) influences
  only local attribution, at the same trust level as its tool choices.
- The Codex path relies on undocumented metadata and must be re-checked on
  Codex upgrades. Its absence degrades to per-connection pairing.
- Once the stripping ships, `_ratel` is a reserved argument name on every Ratel
  gateway tool.

## Rejected

- **A turn id minted in `UserPromptSubmit`:** a prompt submitted while older
  calls are still running relabels them, because the id lives in shared state
  instead of each call.
- **Codex `allow` + `updatedInput` as the primary path:** it works, but it
  touches the approval path for no gain over `_meta`, and the interactive
  approval behaviour is unverified.
- **Declaring `_ratel` in `inputSchema`:** no host requires it, and it puts the
  field in the model's view.
- **The SDK turn scope as the only mechanism:** see decision 5.
- **A per-search id echoed back by the model:** it depends on the model copying
  an opaque id correctly. The rc.10 attribution fix already handles several
  searches in one turn.
