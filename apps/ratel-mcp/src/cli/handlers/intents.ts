import { resolveAnalysisRuntime } from "../../intents/context.js";
import { DEFAULT_EVERY_N_MESSAGES, runAnalysis } from "../../intents/runner.js";
import type { FlagValue } from "../args.js";
import type { HandlerCtx } from "./types.js";

export const INTENTS_USAGE = `usage: ratel-mcp intents <verb>

Verbs:
  run    analyze captured chat and extract intents, matching each against
         Ratel-managed skills

Flags:
  --session <id>   analyze only this chat session
  --all            analyze every session with captured turns
  --every <n>      every-N-messages threshold (default from config, else ${DEFAULT_EVERY_N_MESSAGES})
  --on-idle        also analyze sessions flagged idle by the Stop hook`;

export async function runIntents(ctx: HandlerCtx): Promise<void> {
  if (ctx.argv.verb !== "run") {
    ctx.log(INTENTS_USAGE);
    return;
  }

  const runtime = await resolveAnalysisRuntime(ctx.env, ctx.fs);
  if (runtime.analysis?.enabled === false) {
    ctx.log("intent analysis is disabled (enable it in the UI Settings or ~/.ratel/config.json)");
    return;
  }
  const cadence = runtime.analysis?.cadence ?? {};
  const everyNMessages =
    numberFlag(ctx.argv.flags.every) ?? cadence.everyNMessages ?? DEFAULT_EVERY_N_MESSAGES;
  const onIdle = ctx.argv.flags["on-idle"] === true || cadence.onIdle === true;
  const sessionId = stringFlag(ctx.argv.flags.session);
  const all = ctx.argv.flags.all === true;

  const trigger = sessionId ? "session" : all ? "all" : onIdle ? "idle" : "manual";
  const result = await runAnalysis(
    {
      fs: ctx.fs,
      intentsDir: runtime.paths.intentsDir,
      chatSource: runtime.chatSource,
      extractor: runtime.extractor,
      matchSkill: runtime.matchSkill,
      extractorModel: runtime.analysis?.extractor?.model,
      now: () => new Date().toISOString(),
      log: ctx.log,
    },
    { sessionId, all, everyNMessages, onIdle, trigger },
  );

  if (result.analyzed.length === 0) {
    ctx.log("no sessions were due for analysis");
    return;
  }
  ctx.log(
    `analyzed ${result.analyzed.length} session(s): ` +
      `${result.intentsFound} intents, ${result.gaps} gaps`,
  );
}

function numberFlag(value: FlagValue | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--every requires a positive integer");
  }
  return n;
}

function stringFlag(value: FlagValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
