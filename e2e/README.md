# End-to-end skills check

A real-process integration check for the skills feature — complements the unit
tests by exercising the actual MCP protocol and CLI streams, where two real bugs
once hid (a hook writing to the wrong stream; an error result violating its
output schema).

## What it covers

| Part | Layer | What it proves |
|------|-------|----------------|
| **A** | Gateway (pull) | `ratel-mcp serve` exposes exactly `search_capabilities` / `invoke_tool` / `get_skill_content` / `auth`; the two reserved buckets mean a matching **skill is never starved by matching tools**; `invoke_tool` round-trips to a real upstream MCP; `get_skill_content` returns the body and a clean `{ error }` (not a protocol crash) for an unknown id. |
| **B** | Lifecycle | `skill activate → list → deactivate` moves skills into the Ratel folder and back, reversibly and non-destructively, with an accurate manifest. |
| **C** | Push | The `UserPromptSubmit` preload hook + **real** project-signal detection: the *same* prompt surfaces the React skill in a React repo and the Django skill in a Django repo, and the clear-winner gate stays **silent** when nothing clearly fits. |

`driver.mjs` is the MCP client for Part A; `upstream.mjs` is a throwaway upstream
MCP server; `run.sh` orchestrates all three parts against throwaway `HOME`s.

## Running it

This is **local/manual**, not a CI job — it needs the unified SDK linked and
built (the SDK isn't published yet):

```bash
cd ../ratel/src/sdk/ts && pnpm build
cd ../../../../ratel-mcp
mv node_modules/@ratel-ai/sdk node_modules/@ratel-ai/sdk.orig
ln -s ../ratel/src/sdk/ts node_modules/@ratel-ai/sdk
pnpm build
bash e2e/run.sh        # → "16 passed, 0 failed"
# restore when done:
rm node_modules/@ratel-ai/sdk && mv node_modules/@ratel-ai/sdk.orig node_modules/@ratel-ai/sdk
```

The per-bug regressions are also locked into the normal unit suites
(`src/cli/handlers/skill.test.ts` for the hook stream;
`get_skill_content`'s schema test in the SDK), so CI catches them once the SDK
publishes.
