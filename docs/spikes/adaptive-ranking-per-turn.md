# Spike: per-turn correlation for adaptive ranking

Date: 2026-10-07. Hosts: Claude Code 2.1.289 and 2.1.292 (latest), Codex CLI
0.148.0 and 0.160.1 (latest). The full suite ran on all four versions with
identical results. The latest versions ran through `npx`, leaving the installed
CLIs untouched. Feeds
[ADR 0023](../adr/0023-host-turn-correlation.md).

## Question

Adaptive ranking pairs a `search_capabilities` call with the invokes that follow
it, keyed by the SDK `turnId`. Ratel Local mints one id per MCP connection, so in
a long session a search in turn 1 can pair with an unrelated invoke in turn 5.
Both hosts expose native turn ids to hooks: Claude Code `session_id` +
`prompt_id` (+ `agent_id` in a subagent), and Codex `session_id` + `turn_id`. Can
those ids reach Ratel on every gateway call, safely and reliably?

## Method

A throwaway, zero-dependency stdio MCP server logged the raw `tools/call`
`arguments` and `_meta` it received. It exposed four tools:

- `open_echo`: `query` only.
- `strict_echo`: `additionalProperties: false`.
- `declared_echo`: declares `_ratel`.
- `slow_echo`: sleeps 4 s, for overlapping calls.

A `PreToolUse` hook logged its payload and returned `updatedInput` =
`{ ...tool_input, _ratel: { session, turn, agent? } }`. An environment variable
picked what else it emitted: no `permissionDecision`, `"allow"`, a crash
(exit 1), non-JSON stdout, or a malformed `_ratel`.

- **Claude Code:** the server and hook were loaded as a dev plugin through
  `claude -p --plugin-dir`, so no installed plugin or setting changed.
- **Codex:** they were loaded through `codex exec --ignore-user-config
  --dangerously-bypass-hook-trust`, with `-c` overrides for `mcp_servers.spike`,
  `features.hooks` and an inline `hooks.PreToolUse`. `~/.codex/config.toml` was
  not touched.

The harness lived under the git-ignored `tmp/` and is not committed. The shipped
plugin and marketplace files were not touched.

## Findings: Claude Code

| Question | Result |
|---|---|
| Can `updatedInput` add a field to an MCP call, and does it reach the server? | **Yes.** The server received `_ratel` alongside `query` on all three tools. `updatedInput` replaces the arguments, so the hook must spread `tool_input`. |
| Must the field be declared in `inputSchema`? | **No.** Undeclared `_ratel` reached the server even on `strict_echo` (`additionalProperties: false`), although the docs say the replacement is validated. Ratel's gateway schemas do not set `additionalProperties: false` anyway. |
| Does it change permission prompts? | **No bypass.** With no allow rule, the call was denied exactly as with a hook that output nothing. The denial (and an interactive prompt) shows the rewritten input, `_ratel` included. Allow rules match on tool name and keep working. The hook must **not** set `permissionDecision`, since `"allow"` would skip prompts. |
| Are ids stable within a turn? | **Yes.** Two parallel calls in one message, plus calls from two parallel subagents, all carried the same `prompt_id`. |
| New turn? | A resumed second prompt (`--resume`, a new process and a new MCP connection) kept `session_id` and got a new `prompt_id`. |
| Subagents | They share the parent's `session_id` **and** `prompt_id`. Only `agent_id` (plus `agent_type`) tells them apart, and it differs per subagent. **`agent` is required** to keep subagents apart from the main thread and from each other. |
| Hook crash, non-JSON output, or `disableAllHooks` | The call ran with the original arguments and no `_ratel`. A timed-out `PreToolUse` hook also lets the call proceed (docs). `--bare` skips hooks too. |
| Native ids in `_meta`? | **No.** Calls carry only `_meta["claudecode/toolUseId"]` and a progress token, so a hook is the only channel. |
| Tool names | A plugin-bundled server's tools are `mcp__plugin_<plugin>_<server>__<tool>`. A user-configured server's are `mcp__<server>__<tool>`. A matcher must cover both. |

## Findings: Codex

| Question | Result |
|---|---|
| Does `updatedInput` need `permissionDecision: "allow"`? | **Yes.** Without `allow`, `updatedInput` was silently ignored and the arguments reached the server unchanged. The same happened for a malformed hook output. |
| Does `"allow"` bypass approvals? | **Not in `codex exec`.** An MCP tool with no approval override still failed with "requires approval, but approval policy is never" when the hook returned `allow` + `updatedInput`, identical to a hook that returned nothing. With `default_tools_approval_mode = "approve"`, the rewritten call ran and `_ratel` reached the server. `exec` forces policy `never` even with `-c approval_policy="on-request"`, so the **interactive approval prompt was not exercised**; check that in the TUI before shipping a Codex hook. |
| Must the field be declared? | **No for MCP tools.** `strict_echo` accepted it. Codex's **built-in** tools reject unknown fields, though: an over-broad matcher put `_ratel` on `spawn_agent`, and every spawn failed with "unknown field `_ratel`". The matcher must name Ratel's gateway tools only. |
| Ids within and across turns | One `turn_id` (a UUIDv7) covered every call in a turn. A resumed turn kept `session_id` and got a new `turn_id`. |
| Subagents | They share the parent's `session_id`, and each gets its **own** `turn_id` and `agent_id` (`agent_type: "default"`). Turn ids alone keep them apart; `agent` is harmless. |
| Hook crash, non-JSON output, or a malformed `_ratel` | The call ran unmodified. |
| Untrusted hook | Without persisted trust (or the bypass flag) the hook did not run at all, and the call proceeded without `_ratel`. Plugin hooks also need `features.plugin_hooks`, and trust is pinned to a hash of each hook definition, so changing a shipped hook asks the user to review it again. |
| Native ids in `_meta`? | **Yes, with no hook.** Every MCP `tools/call` carried `_meta["x-codex-turn-metadata"]` with `session_id`, `turn_id` and `thread_id`, plus `parent_thread_id` and `subagent_kind` for a subagent. A subagent's `thread_id` equals its hook `agent_id`. The same object also carries workspace paths, git remotes and commit hashes, model, and sandbox mode, so Ratel should read only the three ids and drop the rest. It is undocumented, as the `x-` prefix suggests, so **Ratel does not rely on it**. |

## Shared conclusions

- **Fallback.** Missing, disabled, untrusted, crashing, or timed-out hooks all
  degrade to a call without `_ratel`. Ratel then uses its per-connection id,
  which is today's behaviour. Nothing breaks, and pairing is only as good as it
  is now.
- **Parallel calls and interrupts.** Ids are read from each call's own
  `PreToolUse` payload, with no shared "current turn" state, so overlapping calls
  and a prompt submitted while older calls run cannot mislabel each other. A
  `UserPromptSubmit` hook that writes a shared file would race here. Interrupts
  were not exercised directly. By construction, a call that was already
  rewritten keeps its turn, and the next prompt gets a new id from the host.
- **Reconnects.** Host ids survive an MCP reconnect or a resumed session. The
  composite key therefore pairs a search and an invoke from one turn even across
  two MCP sessions, which the per-connection id cannot do (see the daemon test
  in `daemon.test.ts`).
- **Ratel's connector.** The shipped plugin runs `ratel connect`, a stdio
  bridge to the daemon. It forwards `request.params` unchanged, so `_ratel` (and
  `_meta`) reaches the daemon (`proxy.test.ts`).
- **Spoofing.** Without a hook, the model could write `_ratel` itself. Because
  the field is not declared, it has no reason to. A wrong id only misattributes
  local learning, the same trust level as the model's own tool choices. The hook
  overwrites any model-supplied value.
- **Encoding.** Session ids are UUIDs on both hosts, and ids from different
  hosts or sessions do not collide in practice. The key encodes session, turn,
  and agent in one injective string, so ids containing separators cannot collide
  either.

## Recommendation

1. **Ratel side:** ship the `_ratel` argument behind
   `RATEL_FEATURE_ADAPTIVE_RANKING_PER_TURN` (done in this change). Do not
   declare it in `inputSchema`. Always strip it. Run each correlated call in the
   SDK turn scope under the composite id.
2. **Claude Code:** add a `PreToolUse` hook, matched only to Ratel's gateway
   tools (`search_capabilities`, `invoke_tool`, `get_skill_content`) under both
   tool-name forms. It returns `updatedInput` with `_ratel` from `session_id`,
   `prompt_id` and `agent_id`, and no `permissionDecision`. It is fail-open and
   overwrites any model-supplied value.
3. **Codex:** the same hook and matcher, returning `permissionDecision:
   "allow"` because Codex ignores `updatedInput` without it. First verify in the
   interactive TUI that `allow` does not skip an approval the user would
   otherwise see. Do not read the undocumented `x-codex-turn-metadata`.
4. Hook wiring in the shipped plugin is a separate change, pending approval.
