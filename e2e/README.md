# End-to-end skills check

A real-process integration check for the skills feature — complements the unit
tests by exercising the actual MCP protocol and CLI streams, where two real bugs
once hid (a hook writing to the wrong stream; an error result violating its
output schema).

## What it covers

| Part | Layer | What it proves |
|------|-------|----------------|
| **A** | Gateway (pull) | `ratel-local serve` exposes `search_capabilities` / deprecated `search_tools` / `invoke_tool` / `get_skill_content` / `auth`; the two reserved buckets mean a matching **skill is never starved by matching tools**; `invoke_tool` round-trips to a real upstream MCP; `get_skill_content` returns the body and a clean `{ error }` (not a protocol crash) for an unknown id. |
| **B** | Lifecycle | `skill activate → list → deactivate` links skills into Ratel without moving their native folders, then reverses the operation non-destructively with an accurate manifest. |
| **C** | Push | The `UserPromptSubmit` preload hook + **real** project-signal detection: the *same* prompt surfaces the React skill in a React repo and the Django skill in a Django repo, and the clear-winner gate stays **silent** when nothing clearly fits. |

`driver.mjs` is the MCP client for Part A; `upstream.mjs` is a throwaway upstream
MCP server; `run.sh` orchestrates all three parts against throwaway `HOME`s.

## Running it

This is **local/manual**, not a CI job. Install the locked workspace
dependencies and build the public app first:

```bash
pnpm install --frozen-lockfile
pnpm build
bash e2e/run.sh        # → "19 passed, 0 failed"
```

The per-bug regressions are also locked into the normal unit suites
(`apps/ratel-local/src/cli/handlers/skill.test.ts` for the hook stream and
`packages/core/src/lib/server.test.ts` for the gateway skill surface), while
this real-process check retains the protocol-level error assertion.
