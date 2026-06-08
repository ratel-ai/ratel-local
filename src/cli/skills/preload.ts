import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Suggestion } from "./suggest.js";

/** Subset of the Claude Code `UserPromptSubmit` hook stdin payload we use. */
export interface HookInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

export interface PreloadDeps {
  /** Rank skills for a prompt (pre-bound with dirs/limit/minScore by the caller). */
  suggest: (prompt: string, cwd: string | undefined) => Promise<Suggestion[]>;
  /** Skill ids already nudged this session. */
  loadNudged: (sessionId: string) => Promise<Set<string>>;
  /** Persist newly-nudged skill ids for this session. */
  recordNudged: (sessionId: string, ids: string[]) => Promise<void>;
}

/**
 * Hook core: given a parsed `UserPromptSubmit` payload, return the
 * `additionalContext` string to inject — a directive pointer naming the exact
 * skill id(s) and the `invoke_skill` call — or `null` to inject nothing.
 *
 * Pure over its dependencies. De-dupes per session so the same skill isn't
 * re-nudged on every prompt.
 */
export async function runPreloadHook(input: HookInput, deps: PreloadDeps): Promise<string | null> {
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) return null;

  const suggestions = await deps.suggest(prompt, input.cwd);
  if (suggestions.length === 0) return null;

  const sessionId = input.session_id ?? "default";
  const already = await deps.loadNudged(sessionId);
  const fresh = suggestions.filter((s) => !already.has(s.skillId));
  if (fresh.length === 0) return null;

  await deps.recordNudged(
    sessionId,
    fresh.map((s) => s.skillId),
  );
  return buildPointer(fresh);
}

/** Parse the raw hook stdin into a {@link HookInput}, tolerant of junk. */
export function parseHookInput(raw: string): HookInput {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
      cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      session_id: typeof obj.session_id === "string" ? obj.session_id : undefined,
    };
  } catch {
    return {};
  }
}

function buildPointer(suggestions: Suggestion[]): string {
  const lines = suggestions.map(
    (s) =>
      `- ${s.skillId}${s.description ? ` — ${s.description}` : ""}  →  invoke_skill("${s.skillId}")`,
  );
  return [
    "Ratel: project-relevant skill(s) may apply to this task. Before writing code, load the relevant " +
      "one(s) with the `invoke_skill` tool and follow them:",
    ...lines,
  ].join("\n");
}

// ── Per-session dedup state (default implementation) ────────────────────────

export function preloadStateDir(homeDir: string): string {
  return join(homeDir, ".ratel", "skill-preload");
}

function sessionFile(stateDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "default";
  return join(stateDir, `${safe}.json`);
}

export async function loadNudged(stateDir: string, sessionId: string): Promise<Set<string>> {
  try {
    const raw = await readFile(sessionFile(stateDir, sessionId), "utf8");
    const ids = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export async function recordNudged(
  stateDir: string,
  sessionId: string,
  ids: string[],
): Promise<void> {
  const file = sessionFile(stateDir, sessionId);
  const existing = await loadNudged(stateDir, sessionId);
  for (const id of ids) existing.add(id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify([...existing])}\n`);
}
