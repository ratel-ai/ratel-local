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
- Codex also sends the same ids in an undocumented
  `_meta["x-codex-turn-metadata"]` object. It is not a supported contract.
- Every failure mode (missing, disabled, untrusted, crashing or timed-out hooks)
  leaves the call unmodified.

SDK `0.13.0-rc.10` adds a turn scope, `turn(fn, { id })` (SDK ADR 0026). It also
credits an invoke to the search that offered the capability, rather than to the
latest search in the turn. Ratel Local pins `0.13.0-rc.11`, the current `rc`
dist-tag.

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
   field becomes the id of an SDK turn
   `rt1:<session>:<turn>[:<agent>]`. Each component is percent-encoded, so the
   `:` separator cannot occur inside one and the encoding is injective. The
   component count tells the main thread from a subagent, and every agent in
   one host turn shares a prefix. Otherwise, with the flag off or the field
   absent or malformed, the per-connection UUID stays.
4. **Not declared** in any `inputSchema`. Neither host needs it, and declaring
   it would invite the model to fill it in.
5. **The SDK turn scope for host turns, an explicit `turnId` for the
   fallback.** A call with a host turn id runs as
   `catalog.turn(() => tool.execute(args), { id })`. Reasons:
   - Every event the call records carries the turn id, on both catalogs,
     including events the gateway tools record without a `turnId` argument,
     such as `gateway_error`.
   - The call opens the turn with one `turn_start`. Reopening an id already
     started emits nothing, so a turn's many calls, even across MCP sessions,
     open it once. Ratel Cloud can then group runs by the host's real turn.
   - It passes no `userMessage` or `endUserId`, so nothing new leaves the
     machine beyond the ids.

   The per-connection fallback is not a user turn. Wrapping it in `turn()`
   would show a connection to Ratel Cloud as a turn, so it keeps passing the
   id explicitly to `tool.execute(args, undefined, turnId)` and opens no
   scope.
6. **Host wiring** is a separate change and follows the spike:
   - **Claude Code:** a fail-open `PreToolUse` hook, matched only to
     `search_capabilities`, `invoke_tool` and `get_skill_content` under both
     plugin and user server names. It returns `updatedInput` =
     `{ ...tool_input, _ratel }` with no `permissionDecision`, and overwrites a
     model-supplied value.
   - **Codex:** the same hook and matcher. Codex ignores `updatedInput`
     without `permissionDecision: "allow"`, so the hook must return it. Before
     this ships, verify in the interactive TUI that `allow` does not skip an
     approval the user would otherwise see. In `codex exec` it did not.

## Consequences

- With a host supplying ids, a search pairs only with invokes from the same host
  turn, across reconnects. Subagents stay apart. Without ids, behaviour is
  exactly as before.
- The flag is independent of `RATEL_FEATURE_ADAPTIVE_RANKING`. On its own it
  changes only the `turn_id` stamped on trace events.
- A client that sends `_ratel` without a hook (a model, a script) influences
  only local attribution, at the same trust level as its tool choices.
- The Codex hook depends on `allow` leaving approvals alone, which is verified
  only headless so far. If the TUI check fails, Codex keeps per-connection
  pairing until there is a hook path that does not touch permissions.
- Once the stripping ships, `_ratel` is a reserved argument name on every Ratel
  gateway tool.

## Rejected

- **A turn id minted in `UserPromptSubmit`:** a prompt submitted while older
  calls are still running relabels them, because the id lives in shared state
  instead of each call.
- **Reading Codex's `_meta["x-codex-turn-metadata"]`:** it would need no hook,
  but it is undocumented, so Ratel would depend on a field Codex may change or
  drop. It also carries workspace paths and git remotes that Ratel has no use
  for.
- **Declaring `_ratel` in `inputSchema`:** no host requires it, and it puts the
  field in the model's view.
- **The SDK turn scope for every call:** see decision 5.
- **An explicit `turnId` for host turns as well:** pairing would be the same,
  but events recorded without a `turnId` argument would lose the turn, and
  Ratel Cloud would get no `turn_start`.
- **A per-search id echoed back by the model:** it depends on the model copying
  an opaque id correctly. The SDK's attribution fix (since rc.10) already handles several
  searches in one turn.
