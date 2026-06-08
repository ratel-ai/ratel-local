# Proposal: Prompt / project-aware skill preloading

Status: **Implemented (pointer mode)** · Created: 2026-06-08

> **Shipped decisions:** matching = **prompt + project signals**; injection = **pointer only** (the hook
> names the exact skill id and instructs the model to load it via `invoke_skill`, rather than inlining the
> body). See "Implementation" at the bottom for the delivered CLI surface and the residual-risk note.

## Summary

Make relevant skills show up **without the agent having to ask** for them. Today a skill surfaces only
when the model decides to call `search_skills`, or — once tool-coupling lands — when it calls a related
tool. This proposal adds a third, earlier trigger: **the user's prompt itself**. When you type "set up auth
with Supabase," Ratel ranks the skill catalog against that prompt (and the project's signals) and injects
the top skill(s) into the turn, so Claude writes code already looking at your Supabase playbook.

## Why this can't live in the MCP gateway

The gateway is an MCP server. An MCP server only ever receives **tool calls** (`tools/list`, `tools/call`).
It never sees the user's prompt or the conversation, and MCP has **no primitive to push content into
context** — content reaches the model only as the result of a tool the model chose to call.

So prompt-level injection needs a different seam. In Claude Code that seam is a **hook** — specifically
`UserPromptSubmit`, which fires on every prompt and *can add context to the turn*. The hook is the only
place that (a) sees the prompt and (b) can inject. Ratel already ships a CLI; the hook is a thin shell that
calls it.

## How it works

```
┌─────────────┐   prompt text    ┌────────────────────────┐   top-K skills    ┌──────────────┐
│ Claude Code │ ───────────────► │ UserPromptSubmit hook  │ ────────────────► │ ratel skill  │
│  (you type) │                  │ (shell, ~10 lines)     │                   │ suggest CLI  │
└─────────────┘                  └────────────────────────┘                   └──────┬───────┘
       ▲                                                                              │ BM25 over
       │   injected skill context (additionalContext)                                │ skill catalog
       └──────────────────────────────────────────────────────────────────────────  ┘
```

1. **Hook fires.** `UserPromptSubmit` passes the prompt (and cwd) to the hook on stdin.
2. **Signals gathered.** The hook calls `ratel skill suggest --prompt "<text>" --cwd <dir>`. The CLI ranks
   the skill catalog (the same BM25 engine, in-process, no LLM) against:
   - the prompt text, and
   - **project signals** detected from `--cwd` — e.g. `supabase/config.toml`, `next.config.js`, deps in
     `package.json`, `Cargo.toml` — folded into the query so "this is a Supabase + Next project" biases
     ranking even when the prompt is terse.
3. **Threshold + cap.** Return at most N skills (default 1–2) above a score floor, so unrelated prompts
   inject nothing. Each result is `{ skillId, body }` (or a compact pointer — see Open questions).
4. **Inject.** The hook emits the skill(s) as `additionalContext` (Claude Code merges hook output into the
   turn). Claude now has the playbook before it writes a line.
5. **De-dupe.** The CLI remembers what it injected this session (a small state file keyed by session id) so
   the same skill isn't re-injected on every prompt.

## What we build

- **`ratel skill suggest`** (new CLI verb) — `--prompt`, `--cwd`, `--limit`, `--min-score`, `--format
  json|context`. Pure function over the existing skill catalog + a small project-signal detector. No new
  ranking infra; reuses `SkillCatalog`/BM25.
- **Project-signal detector** — a table mapping marker files/deps → query terms (`supabase/* → "supabase
  auth database"`, `app/ + next dep → "next.js app router"`, …). Extensible, data-driven.
- **A reference hook** — `hooks/ratel-skill-preload.sh`, ~10 lines, plus a settings snippet:
  ```json
  { "hooks": { "UserPromptSubmit": [
      { "type": "command", "command": "ratel skill preload-hook" } ] } }
  ```
  (Shipping a `ratel skill preload-hook` subcommand that reads the hook's stdin JSON and prints
  `additionalContext` is cleaner than a bash script — one binary, cross-platform.)

## Distribution

Two install tiers, matching how the gateway is distributed:

- **Manual / power user** — `ratel skill install-hook` writes the `UserPromptSubmit` entry into the chosen
  settings scope (user `~/.claude/settings.json` or project `.claude/settings.json`), and
  `ratel skill uninstall-hook` removes it. Mirrors the existing `mcp import` / `backup undo` pattern, with
  the same backup-manifest safety.
- **Bundled with activation** — when a user runs `ratel skill activate` (move skills into Ratel), offer to
  install the preload hook too, so the two halves of the feature arrive together. Opt-in, reversible.

For teams: the hook entry can live in a **project** `.claude/settings.json` committed to the repo, so every
dev who clones the repo gets project-scoped skill preloading with no per-machine setup. The skills
themselves ship in the repo (`.ratel/skills/` or a configured dir) and are ranked locally.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Injecting irrelevant skills (noise/token cost) | Score floor + low cap (1–2) + per-session de-dupe; `--min-score` tunable. |
| Big skill bodies blow the turn budget | Inject a **pointer + 1-line description** by default ("a `supabase-auth` skill is available — say so to load it"), full body only above a higher score, or always via `invoke_skill`. |
| Latency on every prompt | BM25 over a local file set is sub-ms; signal detection is a few `stat`s. Hard-cap the hook's time budget and fail open (inject nothing). |
| Hook fragility across OSes | Ship it as a `ratel` subcommand (Node), not a bash script. |
| Surprise / lack of control | Strictly opt-in install; `ratel skill suggest --dry-run`; a kill switch env var. |

## Open questions (for the review)

1. **Inject body vs. pointer?** Full body = zero extra round-trip but costs tokens up front; pointer = the
   model decides to `invoke_skill`, cheaper but one more hop. Probably: pointer by default, body above a
   high-confidence score.
2. **Prompt-only vs. prompt+project signals in v1?** Project signals add real power but more surface area.
   Could ship prompt-only first.
3. **Where does the hook get the catalog?** Reuse the gateway's configured `skills.dirs`, or a dedicated
   suggest config? Reuse is simpler.
4. **Interaction with tool-coupled skills** (the `relatedSkills` feature): same skill could surface twice
   (prompt + tool). De-dupe across both via the session state file.
5. **Scope precedence** when both user- and project-level hooks are installed.

## Phasing

- **P1** — `ratel skill suggest` (prompt-only, JSON out) + a documented manual hook. Smallest shippable slice.
- **P2** — project-signal detector + `ratel skill preload-hook` subcommand + `install-hook`/`uninstall-hook`.
- **P3** — bundle with `skill activate`, per-session de-dupe, body-vs-pointer heuristics, team/project config.

## Relationship to shipped work

- Reuses the `SkillCatalog` + BM25 core already shipped (ADR-0011 in the library repo).
- Complements **tool-coupled skills** (`relatedSkills` on `search_tools`/`invoke_tool`) — that triggers on
  tool use; this triggers on the prompt. Together they cover "before you act" and "as you act."
- Independent of the **`ratel skill activate/deactivate`** move-in/move-back CLI, but naturally bundled with it.

## Implementation (delivered)

Pointer mode, prompt + project signals. All in `ratel-mcp`, reusing the shipped `SkillCatalog`/BM25,
`loadSkills`, the backup machinery, and the `skill` CLI group.

**Modules**
- `src/cli/skills/signals.ts` — `detectProjectSignals(cwd)`: maps `package.json` deps and marker files
  (`supabase/config.toml`, `next.config.*`, `Cargo.toml`, …) to stack query terms.
- `src/cli/skills/suggest.ts` — `suggestSkills({prompt,cwd,dirs,limit,minScore})`: ranks the catalog over
  `prompt + signals`; `resolveSkillDirs(home)` reads the gateway's `skills.dirs` so suggested ids are
  invokable.
- `src/cli/skills/preload.ts` — `runPreloadHook()` (pure): builds the pointer `additionalContext` and
  de-dupes per session (state under `~/.ratel/skill-preload/<session>.json`); `parseHookInput()`.
- `src/cli/skills/install-hook.ts` — idempotent add/remove of the `UserPromptSubmit` entry in
  `settings.json`, with a backup; resolves the bin path like `mcp import`.

**CLI**
- `ratel-mcp skill suggest --prompt "<text>" [--cwd] [--dir]... [--limit] [--min-score] [--format json]`
  — debug/inspect ranking.
- `ratel-mcp skill preload-hook` — the `UserPromptSubmit` entrypoint: reads the payload on stdin, prints
  `{ hookSpecificOutput: { hookEventName, additionalContext } }`, **fail-open** (never throws, never blocks).
- `ratel-mcp skill install-hook [--scope user|project]` / `uninstall-hook` — wire/unwire the hook.

**Install**
```jsonc
// ~/.claude/settings.json  (written by `skill install-hook`)
{ "hooks": { "UserPromptSubmit": [
  { "hooks": [ { "type": "command", "command": "ratel-mcp skill preload-hook", "timeout": 10 } ] } ] } }
```

**Residual risk (pointer mode):** the hook reliably *injects* the nudge (a system reminder the model reads
deterministically), but the model must still make the `invoke_skill` call, and that call only resolves when
the gateway is running with the skill loaded. The nudge names the exact id + tool to maximize compliance. A
future `--body` flag could inline the skill for zero-hop certainty.
