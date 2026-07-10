import {
  ClaudeStatuslineConflictError,
  installClaudeCodeStatusline,
  type ResolvedBin,
  renderRatelStatusline,
  uninstallClaudeCodeStatusline,
} from "@ratel-ai/ratel-local-core";
import { currentGitBranch } from "../git.js";
import { resolveCliRatelBin } from "../ratel-bin.js";
import { readStdin } from "../stdin.js";
import type { HandlerCtx } from "./types.js";

/**
 * Best-effort statusline install invoked after `link`/`import` wire up Claude
 * Code, so users get it without a separate `statusline install` step. Never
 * blocks or fails the caller: a pre-existing non-Ratel statusLine is left
 * alone (reported as a note) rather than treated as a conflict to resolve.
 */
export async function maybeAutoInstallStatusline(
  ctx: HandlerCtx,
  agentHostKind: string,
  bin: ResolvedBin,
): Promise<void> {
  if (agentHostKind !== "claude-code") return;
  try {
    const result = await installClaudeCodeStatusline(ctx, { bin });
    if (result.changed) {
      ctx.prompts.note(`Installed the Ratel statusline into ${result.path}`, "Statusline");
    }
  } catch (err) {
    if (err instanceof ClaudeStatuslineConflictError) {
      ctx.prompts.note(
        "Skipped statusline install: a non-Ratel statusLine is already configured. Run `ratel-local statusline install --force` to replace it.",
        "Statusline",
      );
      return;
    }
    throw err;
  }
}

export const STATUSLINE_USAGE = `usage: ratel-local statusline [install|uninstall]

Verbs:
  (none)       render the Claude Code statusline (reads Claude JSON from stdin)
  install      write ~/.claude/settings.json statusLine for Ratel
  uninstall    remove only a Ratel-owned statusLine from ~/.claude/settings.json

Flags:
  --yes        skip the confirmation prompt
  --force      replace another configured statusLine during install`;

export async function runStatusline(ctx: HandlerCtx): Promise<void> {
  if (ctx.argv.flags.help === true) {
    ctx.log(STATUSLINE_USAGE);
    return;
  }
  switch (ctx.argv.verb) {
    case undefined: {
      const input = ctx.stdin ? await ctx.stdin() : await readStdin();
      const output = await renderRatelStatusline(ctx, input, {
        telemetryDir: process.env.RATEL_TELEMETRY_DIR,
        gitBranch: currentGitBranch(),
      });
      if (ctx.stdout) ctx.stdout(output);
      else process.stdout.write(output);
      return;
    }

    case "install": {
      const bin = await resolveCliRatelBin(ctx, {
        workspaceRoot: ctx.env.projectRoot,
        exists: (path) => ctx.fs.exists(path),
      });
      const assumeYes = ctx.argv.flags.yes === true;
      const force = ctx.argv.flags.force === true;
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Install the Ratel statusline into ${ctx.env.homeDir}/.claude/settings.json?`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          ctx.log("statusline install cancelled");
          return;
        }
      }
      const result = await installClaudeCodeStatusline(ctx, { bin, force });
      ctx.log(
        result.changed
          ? `installed Ratel statusline into ${result.path}`
          : "Ratel statusline already installed",
      );
      return;
    }

    case "uninstall": {
      const assumeYes = ctx.argv.flags.yes === true;
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Remove the Ratel statusline from ${ctx.env.homeDir}/.claude/settings.json?`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          ctx.log("statusline uninstall cancelled");
          return;
        }
      }
      const result = await uninstallClaudeCodeStatusline(ctx);
      ctx.log(
        result.changed
          ? `removed Ratel statusline from ${result.path}`
          : "no Ratel statusline to remove",
      );
      return;
    }

    default:
      ctx.log(STATUSLINE_USAGE);
  }
}
