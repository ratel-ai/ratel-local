import type { RatelConfig } from "../../lib/index.js";
import { type AgentHostState, AutomaticAgentHostAdapter } from "../agent-host/index.js";
import type { BackupManifest } from "../backup.js";
import { isRatelGatewayEntry } from "../gateway-entry.js";
import { ratelConfigPath } from "../hierarchy.js";
import { buildAgentImportPlan, type buildImportPlan } from "../import-plan.js";
import { readJson } from "../io.js";
import { locateRatelBin, type ResolvedBin } from "../locate-bin.js";
import { executePlan } from "../plan-exec.js";
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

  const agentKnown = collectAgentNames(agentState);
  const overlap = [...agentKnown].filter((n) => ratelKnown.has(n));
  if (overlap.length === 0) {
    ctx.prompts.note(
      `No ${agentState.host.displayName} entries match any Ratel entry. Run \`import\` to migrate agent entries first.`,
    );
    ctx.prompts.outro("done");
    return null;
  }

  const bin = opts.bin ?? (await resolveBin(ctx, opts));

  const plan = await buildAgentImportPlan(
    {
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
    },
    { selection: new Set(overlap) },
  );

  if (plan.agentChanges.length === 0) {
    ctx.prompts.outro(`nothing to do (${agentState.host.displayName} already points at Ratel)`);
    return null;
  }

  ctx.prompts.note(renderAgentStage(plan), `${agentState.host.displayName} rewrites`);

  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: `Replace ${plan.agentChanges.length} ${agentState.host.displayName} entr${
        plan.agentChanges.length === 1 ? "y" : "ies"
      } with the ratel-mcp entry?`,
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
  ctx.prompts.note(`Backup created. Run \`ratel-mcp backup undo\` to revert.`, "Done");
  ctx.prompts.outro(
    `link complete · restart ${agentState.host.displayName} to pick up the new MCP entry`,
  );
  return manifest;
}

function collectAgentNames(state: AgentHostState): Set<string> {
  const out = new Set<string>();
  for (const scope of state.scopes) {
    for (const [name, entry] of Object.entries(scope.mcpServers)) {
      if (!isRatelGatewayEntry(name, entry)) out.add(name);
    }
  }
  return out;
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
    "MCP entries now managed by Ratel will be replaced by a single ratel-mcp entry. Other agent MCP entries are preserved.",
  );
  return lines.join("\n");
}
