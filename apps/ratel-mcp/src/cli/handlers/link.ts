import type { BackupManifest, RatelConfig } from "@ratel-ai/mcp-core";
import {
  AutomaticAgentHostAdapter,
  buildAgentLinkPlan,
  type buildImportPlan,
  executePlan,
  locateRatelBin,
  type ResolvedBin,
  ratelConfigPath,
  readJson,
} from "@ratel-ai/mcp-core";
import type { HandlerCtx } from "./types.js";

export interface LinkOptions {
  yes?: boolean;
  bin?: ResolvedBin;
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  exists?: (path: string) => Promise<boolean>;
}

export async function runLink(
  ctx: HandlerCtx,
  opts: LinkOptions = {},
): Promise<BackupManifest | null> {
  ctx.prompts.intro("Ratel · link agent at Ratel");

  const agentHost = new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  if (!detection.present) {
    ctx.prompts.note("No supported agent config found. Nothing to link.");
    ctx.prompts.outro("done");
    return null;
  }
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });

  const ratelUserPath = ratelConfigPath("user", ctx.env);
  const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
  const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;

  const ratelUser = await readJson<RatelConfig>(ctx.fs, ratelUserPath);
  const ratelProject = ratelProjectPath
    ? await readJson<RatelConfig>(ctx.fs, ratelProjectPath)
    : null;
  const ratelLocal = ratelLocalPath ? await readJson<RatelConfig>(ctx.fs, ratelLocalPath) : null;

  const ratelKnown = new Set<string>();
  for (const cfg of [ratelUser, ratelProject, ratelLocal]) {
    if (cfg) for (const name of Object.keys(cfg.mcpServers)) ratelKnown.add(name);
  }
  if (ratelKnown.size === 0) {
    ctx.prompts.note("No Ratel entries found at any scope. Nothing to link.");
    ctx.prompts.outro("done");
    return null;
  }

  const bin = opts.bin ?? (await resolveBin(ctx, opts));

  const plan = await buildAgentLinkPlan({
    agentHost,
    agentState,
    ratelUser,
    ratelProject,
    ratelLocal,
    bin,
    ratelUserPath,
    ratelProjectPath,
    ratelLocalPath,
    projectRoot: ctx.env.projectRoot,
  });

  if (plan.agentChanges.length === 0) {
    ctx.prompts.outro(`nothing to do (${agentState.host.displayName} already points at Ratel)`);
    return null;
  }

  ctx.prompts.note(renderAgentStage(plan), `${agentState.host.displayName} rewrites`);

  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: `Write the ratel-mcp gateway into ${plan.agentChanges.length} ${
        agentState.host.displayName
      } config file${plan.agentChanges.length === 1 ? "" : "s"}?`,
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      ctx.prompts.cancel("link cancelled");
      return null;
    }
  }

  const manifest = await executePlan(plan.agentChanges, {
    fs: ctx.fs,
    env: ctx.env,
    action: "link",
  });
  ctx.prompts.note(`Backup created. Run \`ratel-mcp backup list\` to inspect backups.`, "Done");
  ctx.prompts.outro(
    `link complete · restart ${agentState.host.displayName} to pick up the new MCP entry`,
  );
  return manifest;
}

async function resolveBin(ctx: HandlerCtx, opts: LinkOptions): Promise<ResolvedBin> {
  return locateRatelBin({
    envVar: opts.envVar ?? process.env.RATEL_MCP_BIN,
    whichResult: opts.whichResult ?? (await whichRatelBin()),
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
    promptForPath: async () => {
      const v = await ctx.prompts.text({ message: "Path to ratel-mcp binary?" });
      return ctx.prompts.isCancel(v) ? "" : (v as string);
    },
  });
}

async function whichRatelBin(): Promise<string | undefined> {
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("which ratel-mcp", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function renderAgentStage(plan: ReturnType<typeof buildImportPlan>): string {
  const lines = plan.agentChanges.map(
    (c) => `write ${c.path}${c.before === null ? " (new file)" : ""}`,
  );
  lines.push("");
  lines.push(
    "The ratel-mcp gateway entry will be written for the available Ratel scopes. Native agent MCP entries are preserved.",
  );
  return lines.join("\n");
}
