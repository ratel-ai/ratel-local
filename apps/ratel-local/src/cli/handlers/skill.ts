import type { FlagValue } from "../args.js";
import { resolveCliRatelBin } from "../ratel-bin.js";
import {
  type HookScope,
  installHook,
  preloadHookCommand,
  settingsPathForScope,
  uninstallHook,
} from "../skills/install-hook.js";
import {
  activateSkills,
  deactivateSkills,
  defaultSkillManagePaths,
  listManaged,
} from "../skills/manage.js";
import {
  loadNudged,
  parseHookInput,
  preloadStateDir,
  recordNudged,
  runPreloadHook,
} from "../skills/preload.js";
import { defaultSignalCacheFile, detectProjectSignalsCached } from "../skills/signals.js";
import { resolveSkillDirs, suggestSkills } from "../skills/suggest.js";
import { readStdin } from "../stdin.js";
import type { HandlerCtx } from "./types.js";

export const SKILL_USAGE = `usage: ratel-local skill <verb>

Verbs:
  activate         manage Claude/Codex skills through Ratel as invoke-only
                   without moving the native skill folders
  deactivate       stop managing linked skills and restore Ratel metadata edits
  list             show which skills Ratel currently manages
  suggest          rank skills for a prompt (--prompt, --cwd, --dir, --limit, --min-score)
  preload-hook     UserPromptSubmit hook entrypoint (reads JSON on stdin; injects a nudge)
  install-hook     register the preload hook in settings.json (--scope user|project)
  uninstall-hook   remove the preload hook from settings.json (--scope user|project)

Flags:
  --dry-run        report what would be managed without touching any files
  --yes            skip the confirmation prompt`;

export async function runSkill(ctx: HandlerCtx): Promise<void> {
  const verb = ctx.argv.verb;
  const paths = defaultSkillManagePaths(ctx.env.homeDir);
  const dryRun = ctx.argv.flags["dry-run"] === true;
  const assumeYes = ctx.argv.flags.yes === true;

  switch (verb) {
    case "activate": {
      const pending = await activateSkills(paths, { dryRun: true });
      if (pending.managed.length === 0) {
        ctx.log("no skills to activate (nothing new in native skill folders)");
        return;
      }
      if (dryRun) {
        for (const m of pending.managed) ctx.log(`would manage ${m.id} as invoke-only`);
        return;
      }
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Manage ${pending.managed.length} skill(s) through Ratel as invoke-only? (reversible with "skill deactivate")`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          ctx.log("activate cancelled");
          return;
        }
      }
      const result = await activateSkills(paths, { logger: ctx.log });
      ctx.log(`managing ${result.managed.length} skill(s) as invoke-only`);
      return;
    }

    case "deactivate": {
      const pending = await deactivateSkills(paths, { dryRun: true });
      if (pending.unmanaged.length === 0) {
        ctx.log("no managed skills to deactivate");
        return;
      }
      if (dryRun) {
        for (const r of pending.unmanaged) ctx.log(`would stop managing ${r.id}`);
        return;
      }
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Stop managing ${pending.unmanaged.length} skill(s) through Ratel?`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          ctx.log("deactivate cancelled");
          return;
        }
      }
      const result = await deactivateSkills(paths, { logger: ctx.log });
      ctx.log(`deactivated ${result.unmanaged.length} skill(s)`);
      return;
    }

    case "list": {
      const managed = await listManaged(paths);
      if (managed.length === 0) {
        ctx.log("Ratel manages no skills (run `ratel-local skill activate`)");
        return;
      }
      ctx.log(`Ratel manages ${managed.length} skill(s):`);
      for (const m of managed) {
        ctx.log(`  ${m.id}  (from ${m.originalPath})`);
      }
      return;
    }

    case "suggest": {
      const prompt = strFlag(ctx.argv.flags.prompt);
      if (!prompt) {
        ctx.log(
          'usage: ratel-local skill suggest --prompt "<text>" [--cwd <dir>] [--dir <path>]...',
        );
        return;
      }
      const dirs = dirsFlag(ctx.argv.flags.dir) ?? (await resolveSkillDirs(ctx.env.homeDir));
      const suggestions = await suggestSkills({
        prompt,
        cwd: strFlag(ctx.argv.flags.cwd),
        dirs,
        limit: numFlag(ctx.argv.flags.limit) ?? 5,
        minScore: numFlag(ctx.argv.flags["min-score"]) ?? 0,
      });
      if (ctx.argv.flags.format === "json") {
        ctx.log(JSON.stringify(suggestions, null, 2));
        return;
      }
      if (suggestions.length === 0) {
        ctx.log("no matching skills");
        return;
      }
      for (const s of suggestions) {
        ctx.log(`${s.skillId}  (score ${s.score.toFixed(2)})  ${s.description}`);
      }
      return;
    }

    case "preload-hook": {
      // Hook entrypoint: read the UserPromptSubmit payload on stdin, inject a
      // pointer if a skill matches. Fail-open — never throw, never block.
      try {
        const input = parseHookInput(await readStdin());
        const dirs = await resolveSkillDirs(ctx.env.homeDir);
        const stateDir = preloadStateDir(ctx.env.homeDir);
        const limit = numFlag(ctx.argv.flags.limit) ?? 1;
        const minScore = numFlag(ctx.argv.flags["min-score"]) ?? 0;
        // Cache project-signal detection across prompts: it only re-reads the
        // project's manifests when one changes, instead of on every keystroke-prompt.
        const signalCacheFile = defaultSignalCacheFile(ctx.env.homeDir);
        const additionalContext = await runPreloadHook(input, {
          suggest: (prompt, cwd) =>
            suggestSkills(
              { prompt, cwd, dirs, limit, minScore, requireClearWinner: true },
              {
                detectProjectSignals: (c) =>
                  detectProjectSignalsCached(c, { cacheFile: signalCacheFile }),
              },
            ),
          loadNudged: (sessionId) => loadNudged(stateDir, sessionId),
          recordNudged: (sessionId, ids) => recordNudged(stateDir, sessionId, ids),
        });
        if (additionalContext) {
          // Claude Code reads the UserPromptSubmit hook's STDOUT for this JSON.
          // ctx.log is stderr (kept clean for human/diagnostic logs), so the
          // machine-read hook payload must go to stdout directly — otherwise the
          // injected context is silently dropped.
          process.stdout.write(
            `${JSON.stringify({
              hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
            })}\n`,
          );
        }
      } catch {
        // fail-open: inject nothing
      }
      return;
    }

    case "install-hook":
    case "uninstall-hook": {
      const scope = hookScope(ctx.argv.flags.scope);
      const settingsPath = settingsPathForScope(scope, ctx.env);
      const deps = { fs: ctx.fs, env: ctx.env };
      if (verb === "uninstall-hook") {
        const { changed } = await uninstallHook(settingsPath, deps);
        ctx.log(
          changed ? `removed preload hook from ${settingsPath}` : "no preload hook to remove",
        );
        return;
      }
      const bin = await resolveCliRatelBin(ctx);
      const command = preloadHookCommand(bin);
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Add the Ratel skill-preload hook to ${settingsPath}?`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          ctx.log("install-hook cancelled");
          return;
        }
      }
      const { changed } = await installHook(settingsPath, command, deps);
      ctx.log(
        changed ? `installed preload hook into ${settingsPath}` : "preload hook already installed",
      );
      return;
    }

    default:
      ctx.log(SKILL_USAGE);
  }
}

function strFlag(v: FlagValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numFlag(v: FlagValue | undefined): number | undefined {
  const s = strFlag(v);
  if (s === undefined || s.trim() === "") return undefined; // empty/blank is not 0
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function dirsFlag(v: FlagValue | undefined): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v;
  return undefined;
}

function hookScope(v: FlagValue | undefined): HookScope {
  return v === "project" ? "project" : "user";
}
