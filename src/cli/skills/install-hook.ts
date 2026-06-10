import { join } from "node:path";
import { type BackupFs, startBackup } from "../backup.js";
import type { HierarchyEnv } from "../hierarchy.js";
import { type JsonFs, readJson, writeJson } from "../io.js";
import type { ResolvedBin } from "../locate-bin.js";

/** Substring that identifies a Ratel preload hook entry (for idempotency/removal). */
const MARKER = "skill preload-hook";
const HOOK_EVENT = "UserPromptSubmit";

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export type HookScope = "user" | "project";

/** Path to the Claude Code settings file for a scope. */
export function settingsPathForScope(scope: HookScope, env: HierarchyEnv): string {
  if (scope === "user") {
    return join(env.homeDir, ".claude", "settings.json");
  }
  if (!env.projectRoot) {
    throw new Error('scope "project" requires a project root');
  }
  return join(env.projectRoot, ".claude", "settings.json");
}

/** Render the settings hook command string for the resolved ratel-mcp binary. */
export function preloadHookCommand(bin: ResolvedBin): string {
  return [bin.command, ...bin.args, "skill", "preload-hook"].filter(Boolean).join(" ");
}

/**
 * Return settings with a `UserPromptSubmit` preload hook added. Idempotent:
 * if an entry already references our command marker, the input is returned
 * unchanged (same reference), so callers can detect a no-op.
 */
export function addPreloadHook(
  settings: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  const list = readMatchers(settings);
  if (list.some((m) => m.hooks.some((h) => h.command.includes(MARKER)))) {
    return settings;
  }
  const next = clone(settings);
  if (!next.hooks || typeof next.hooks !== "object") next.hooks = {};
  const hooks = next.hooks as Record<string, unknown>;
  hooks[HOOK_EVENT] = [...list, { hooks: [{ type: "command", command, timeout: 10 }] }];
  return next;
}

/** Return settings with any Ratel preload hook removed (no-op returns same reference). */
export function removePreloadHook(settings: Record<string, unknown>): Record<string, unknown> {
  const list = readMatchers(settings);
  const cleaned = list
    .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !h.command.includes(MARKER)) }))
    .filter((m) => m.hooks.length > 0);
  if (cleaned.length === list.length) return settings;

  const next = clone(settings);
  const hooks = next.hooks as Record<string, unknown>;
  if (cleaned.length === 0) {
    delete hooks[HOOK_EVENT];
  } else {
    hooks[HOOK_EVENT] = cleaned;
  }
  return next;
}

export interface HookFsDeps {
  fs: JsonFs & BackupFs;
  env: HierarchyEnv;
  now?: () => Date;
}

/** Install the preload hook into a settings file, backing it up first. */
export async function installHook(
  settingsPath: string,
  command: string,
  deps: HookFsDeps,
): Promise<{ changed: boolean }> {
  return applyHookEdit(settingsPath, (s) => addPreloadHook(s, command), deps);
}

/** Remove the preload hook from a settings file, backing it up first. */
export async function uninstallHook(
  settingsPath: string,
  deps: HookFsDeps,
): Promise<{ changed: boolean }> {
  return applyHookEdit(settingsPath, removePreloadHook, deps);
}

async function applyHookEdit(
  settingsPath: string,
  transform: (s: Record<string, unknown>) => Record<string, unknown>,
  deps: HookFsDeps,
): Promise<{ changed: boolean }> {
  let before: Record<string, unknown>;
  try {
    before = ((await readJson(deps.fs, settingsPath)) as Record<string, unknown> | null) ?? {};
  } catch (err) {
    // settings.json exists but isn't valid JSON (e.g. hand-edited with comments).
    // Refuse with an actionable message rather than risk clobbering it.
    throw new Error(
      `${settingsPath} is not valid JSON (${(err as Error).message}). ` +
        "Fix or remove it, then re-run — Claude Code settings must be plain JSON without comments.",
    );
  }
  const after = transform(before);
  if (after === before) return { changed: false };

  const backup = startBackup(deps.env, deps.fs, deps.now);
  await backup.capture(settingsPath);
  await backup.finalize("edit");
  await writeJson(deps.fs, settingsPath, after);
  return { changed: true };
}

function readMatchers(settings: Record<string, unknown>): HookMatcher[] {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const raw = (hooks as Record<string, unknown>)[HOOK_EVENT];
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const entry = (m ?? {}) as { matcher?: unknown; hooks?: unknown };
    const hookList = Array.isArray(entry.hooks) ? (entry.hooks as HookCommand[]) : [];
    return {
      ...(typeof entry.matcher === "string" ? { matcher: entry.matcher } : {}),
      hooks: hookList,
    };
  });
}

function clone(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
