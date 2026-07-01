import type { BackupManifest, RatelConfig, ServerEntry } from "@ratel-ai/mcp-core";
import {
  type AgentHostState,
  type AgentScope,
  AutomaticAgentHostAdapter,
  buildAgentImportPlan,
  conflictKey,
  executePlan,
  type FileChange,
  type ImportConflict,
  type ImportConflictStrategy,
  type ImportPlan,
  isRatelGatewayEntry,
  NamedAgentHostAdapter,
  probeEntryInstructions,
  type ResolvedBin,
  ratelConfigPath,
  readJson,
  type SupportedAgentHostKind,
} from "@ratel-ai/mcp-core";
import { ArgError } from "../args.js";
import { resolveCliRatelBin } from "../ratel-bin.js";
import { maybeAutoInstallStatusline } from "./statusline.js";
import type { HandlerCtx } from "./types.js";

export type ProbeFn = (name: string, entry: ServerEntry) => Promise<string | undefined>;

export interface ImportFlowOptions {
  yes?: boolean;
  dryRun?: boolean;
  conflictStrategy?: ImportConflictStrategy;
  bin?: ResolvedBin;
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  agentKind?: SupportedAgentHostKind;
  exists?: (path: string) => Promise<boolean>;
  probe?: ProbeFn;
}

interface Candidate {
  name: string;
  scope: AgentScope;
  hasDescription: boolean;
}

interface ConflictResolution {
  conflictStrategy: ImportConflictStrategy;
  replaceConflicts?: Set<string>;
}

type ConflictResolutionResult =
  | { kind: "resolved"; resolution: ConflictResolution }
  | { kind: "cancelled" };

export async function runImport(
  ctx: HandlerCtx,
  opts: ImportFlowOptions = {},
): Promise<BackupManifest | null> {
  ctx.prompts.intro("Ratel · import agent MCP servers");

  const agentHost = opts.agentKind
    ? new NamedAgentHostAdapter(opts.agentKind)
    : new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  if (!detection.present) {
    ctx.prompts.note("No supported agent MCP servers found at any scope. Nothing to import.");
    ctx.prompts.outro("done");
    return null;
  }
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });

  const candidates = collectCandidates(agentState);
  if (candidates.length === 0) {
    ctx.prompts.note(
      `No ${agentState.host.displayName} MCP servers found at any scope. Nothing to import.`,
    );
    ctx.prompts.outro("done");
    return null;
  }
  ctx.prompts.note(renderDetectedAgentSources(agentState), "Detected agent");

  const ratelUserPath = ratelConfigPath("user", ctx.env);
  const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
  const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;

  const bin = opts.bin ?? (await resolveBin(ctx, opts));

  const ratelUser = await readJson<RatelConfig>(ctx.fs, ratelUserPath);
  const ratelProject = ratelProjectPath
    ? await readJson<RatelConfig>(ctx.fs, ratelProjectPath)
    : null;
  const ratelLocal = ratelLocalPath ? await readJson<RatelConfig>(ctx.fs, ratelLocalPath) : null;

  const selection = await selectCandidates(ctx, candidates, opts);
  if (selection === null) {
    ctx.prompts.cancel("import cancelled");
    return null;
  }

  await captureDescriptions(ctx, selection, agentState, opts);

  const planInputs = {
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
  };
  const planOptions = { selection: new Set(selection.map((c) => c.name)) };
  const initialPlan = await buildAgentImportPlan(planInputs, planOptions);
  const conflictResolution = await resolveConflictStrategy(
    ctx,
    initialPlan,
    opts,
    agentState.host.displayName,
  );
  if (conflictResolution.kind === "cancelled") {
    ctx.prompts.cancel("import cancelled (no writes)");
    return null;
  }

  const plan = await buildAgentImportPlan(planInputs, {
    ...planOptions,
    ...conflictResolution.resolution,
  });

  ctx.prompts.note(renderSummary(plan, agentState.host.displayName), "Summary");

  if (plan.ratelChanges.length === 0 && plan.agentChanges.length === 0) {
    ctx.prompts.outro("nothing to do");
    return null;
  }

  if (opts.dryRun) {
    for (const c of [...plan.ratelChanges, ...plan.agentChanges]) {
      if (c.kind === "write") ctx.log(`would write ${c.path}`);
    }
    ctx.prompts.outro("dry-run complete");
    return null;
  }

  let stageAManifest: BackupManifest | null = null;
  if (plan.ratelChanges.length > 0) {
    ctx.prompts.note(renderDiff(plan.ratelChanges), "Ratel config changes");
    if (!opts.yes) {
      const ok = await ctx.prompts.confirm({
        message: `Apply ${plan.ratelChanges.length} Ratel config change(s)?`,
        initialValue: true,
      });
      if (ctx.prompts.isCancel(ok) || ok === false) {
        ctx.prompts.cancel("import cancelled (no writes)");
        return null;
      }
    }
    stageAManifest = await tryExecute(ctx, plan.ratelChanges, "import");
  }

  if (plan.agentChanges.length === 0) {
    await maybeAutoInstallStatusline(ctx, agentState.host.kind, bin);
    ctx.prompts.outro(`import complete · no ${agentState.host.displayName} changes needed`);
    return stageAManifest;
  }

  ctx.prompts.note(
    renderAgentStage(plan, agentState.host.displayName),
    `${agentState.host.displayName} config changes`,
  );
  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: `Replace ${plan.agentChanges.length} ${agentState.host.displayName} entr${
        plan.agentChanges.length === 1 ? "y" : "ies"
      } with the ratel-mcp entry?`,
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      ctx.log(
        `${agentState.host.displayName} config changes skipped. Run \`ratel-mcp link\` (or re-run \`ratel-mcp import\`) to point ${agentState.host.displayName} at Ratel later.`,
      );
      ctx.prompts.outro(
        `Ratel config changes applied · ${agentState.host.displayName} config changes skipped`,
      );
      return stageAManifest;
    }
  }

  const stageBManifest = await tryExecute(ctx, plan.agentChanges, "import");
  ctx.prompts.note(`Backup created. Run \`ratel-mcp backup list\` to inspect backups.`, "Done");
  await maybeAutoInstallStatusline(ctx, agentState.host.kind, bin);
  ctx.prompts.outro(
    `import complete · restart ${agentState.host.displayName} to pick up the new MCP entry`,
  );
  return stageBManifest;
}

async function resolveConflictStrategy(
  ctx: HandlerCtx,
  plan: ImportPlan,
  opts: ImportFlowOptions,
  agentHostName: string,
): Promise<ConflictResolutionResult> {
  if (plan.summary.conflicts.length === 0) {
    return { kind: "resolved", resolution: { conflictStrategy: "add-missing-only" } };
  }
  ctx.prompts.note(
    renderConflicts(plan.summary.conflicts, agentHostName),
    "Ratel import conflicts",
  );
  if (opts.conflictStrategy) {
    if (opts.conflictStrategy === "replace-selected" && (opts.yes || opts.dryRun)) {
      throw new ArgError(
        "--conflict-strategy replace-selected cannot be combined with --yes or --dry-run",
      );
    }
    return resolveSelectedConflicts(ctx, plan, opts.conflictStrategy, agentHostName);
  }
  if (opts.dryRun) {
    ctx.prompts.note("Ratel conflict strategy: keep existing Ratel definitions", "Dry run");
    return { kind: "resolved", resolution: { conflictStrategy: "add-missing-only" } };
  }
  if (opts.yes) return { kind: "resolved", resolution: { conflictStrategy: "add-missing-only" } };
  const picked = await ctx.prompts.select<ImportConflictStrategy | "cancel">({
    message:
      plan.summary.conflicts.length === 1
        ? "This name already exists in Ratel. What should Ratel contain?"
        : "These names already exist in Ratel. What should Ratel contain?",
    initialValue: "add-missing-only",
    options: conflictStrategyOptions(plan.summary.conflicts.length, agentHostName),
  });
  if (ctx.prompts.isCancel(picked) || picked === "cancel") return { kind: "cancelled" };
  return resolveSelectedConflicts(ctx, plan, picked as ImportConflictStrategy, agentHostName);
}

async function resolveSelectedConflicts(
  ctx: HandlerCtx,
  plan: ImportPlan,
  conflictStrategy: ImportConflictStrategy,
  agentHostName: string,
): Promise<ConflictResolutionResult> {
  if (conflictStrategy !== "replace-selected") {
    return { kind: "resolved", resolution: { conflictStrategy } };
  }

  const selected = await ctx.prompts.multiselect<string>({
    message: `Pick conflicts to replace from ${agentHostName}`,
    required: false,
    options: plan.summary.conflicts.map((c) => ({
      value: conflictKey(c.scope, c.name),
      label: `${c.name} [${c.scope}]`,
      hint: `${summarizeEntry(c.existing)} -> ${summarizeEntry(c.incoming)}`,
    })),
    initialValues: [],
  });
  if (ctx.prompts.isCancel(selected)) return { kind: "cancelled" };
  return {
    kind: "resolved",
    resolution: { conflictStrategy, replaceConflicts: new Set(selected as string[]) },
  };
}

function conflictStrategyOptions(conflictCount: number, agentHostName: string) {
  const options: Array<{
    value: ImportConflictStrategy | "cancel";
    label: string;
    hint: string;
  }> = [
    {
      value: "add-missing-only",
      label:
        conflictCount === 1 ? "Keep existing Ratel definition" : "Keep existing Ratel definitions",
      hint:
        conflictCount === 1
          ? `Do not import the conflicting ${agentHostName} definition.`
          : `Do not import the conflicting ${agentHostName} definitions.`,
    },
  ];
  if (conflictCount > 1) {
    options.push({
      value: "replace-selected",
      label: "Replace selected Ratel definitions",
      hint: `Choose which existing Ratel definitions to overwrite with ${agentHostName} definitions.`,
    });
  }
  options.push(
    {
      value: "replace-from-agent",
      label:
        conflictCount === 1
          ? `Replace Ratel definition from ${agentHostName}`
          : `Replace all Ratel definitions from ${agentHostName}`,
      hint:
        conflictCount === 1
          ? `Overwrite the existing Ratel definition with the ${agentHostName} definition.`
          : `Overwrite each existing Ratel definition with its ${agentHostName} definition.`,
    },
    {
      value: "cancel",
      label: "Cancel",
      hint: "Exit before writing files.",
    },
  );
  return options;
}

function collectCandidates(state: AgentHostState): Candidate[] {
  const out: Candidate[] = [];
  for (const scopeState of state.scopes) {
    for (const [name, entry] of Object.entries(scopeState.mcpServers)) {
      if (isRatelGatewayEntry(name, entry)) continue;
      out.push({
        name,
        scope: scopeState.scope,
        hasDescription: typeof entry.description === "string",
      });
    }
  }
  return out;
}

function renderDetectedAgentSources(state: AgentHostState): string {
  const lines = [`${state.host.displayName} (${state.host.kind})`];
  for (const scopeState of state.scopes) {
    const nativeEntries = Object.entries(scopeState.mcpServers).filter(
      ([name, entry]) => !isRatelGatewayEntry(name, entry),
    );
    if (nativeEntries.length === 0) continue;
    lines.push(
      `- ${scopeState.scope}: ${scopeState.path} (${nativeEntries.length} MCP${
        nativeEntries.length === 1 ? "" : "s"
      })`,
    );
  }
  return lines.join("\n");
}

async function selectCandidates(
  ctx: HandlerCtx,
  candidates: Candidate[],
  opts: ImportFlowOptions,
): Promise<Candidate[] | null> {
  if (opts.yes) return candidates;
  const picked = await ctx.prompts.multiselect<string>({
    message: "Pick the upstream MCPs to migrate into Ratel",
    options: candidates.map((c) => ({
      value: tagOf(c),
      label: `${c.name} [${c.scope}]`,
    })),
    initialValues: candidates.map(tagOf),
    required: false,
  });
  if (ctx.prompts.isCancel(picked)) return null;
  const selected = picked as string[];
  const set = new Set(selected);
  return candidates.filter((c) => set.has(tagOf(c)));
}

function tagOf(c: Candidate): string {
  return `${c.scope}:${c.name}`;
}

async function captureDescriptions(
  ctx: HandlerCtx,
  selected: Candidate[],
  state: AgentHostState,
  opts: ImportFlowOptions,
): Promise<void> {
  if (opts.yes) return;
  const entriesByScope = new Map(state.scopes.map((scope) => [scope.scope, scope.mcpServers]));
  const targets = selected
    .filter((c) => !c.hasDescription)
    .map((c) => ({ c, entry: entriesByScope.get(c.scope)?.[c.name] }))
    .filter((t): t is { c: Candidate; entry: ServerEntry } => Boolean(t.entry));
  if (targets.length === 0) return;

  const probe = opts.probe ?? ((name, entry) => probeEntryInstructions(name, entry));
  const sp = ctx.prompts.spinner();
  sp.start("Spinning up the MCPs to get instructions...");
  let fetched: Array<string | undefined>;
  try {
    fetched = await Promise.all(
      targets.map(({ c, entry }) => probe(c.name, entry).catch(() => undefined)),
    );
  } finally {
    sp.stop("Probed upstream MCPs");
  }

  for (let i = 0; i < targets.length; i++) {
    const { c, entry } = targets[i];
    const instructions = fetched[i];
    const noteBody =
      instructions && instructions.trim().length > 0
        ? instructions
        : "(none provided by the upstream MCP)";
    ctx.prompts.note(noteBody, `Upstream instructions · ${c.name}`);

    const initialValue = instructions ? previewInstructions(instructions) : "";
    const v = await ctx.prompts.text({
      message: `Description for "${c.name}" [${c.scope}] — a brief, concise summary is recommended`,
      placeholder: initialValue ? undefined : "(leave blank to skip)",
      initialValue,
    });
    if (ctx.prompts.isCancel(v)) continue;
    const text = (v as string).trim();
    if (text.length > 0) entry.description = text;
  }
}

function previewInstructions(s: string): string {
  const trimmed = s.trimStart();
  const newlineIdx = trimmed.indexOf("\n");
  const candidate = newlineIdx >= 0 ? trimmed.slice(0, newlineIdx) : trimmed;
  const trimmedEnd = candidate.trimEnd();
  if (trimmedEnd.length <= 120) return trimmedEnd;
  return `${trimmedEnd.slice(0, 119).trimEnd()}…`;
}

async function tryExecute(
  ctx: HandlerCtx,
  changes: readonly FileChange[],
  action: BackupManifest["action"],
): Promise<BackupManifest> {
  try {
    return await executePlan(changes, { fs: ctx.fs, env: ctx.env, action });
  } catch (err) {
    ctx.log(`error during execution: ${(err as Error).message}`);
    ctx.log(`partial backup may exist under ~/.ratel/backups/.`);
    throw err;
  }
}

async function resolveBin(ctx: HandlerCtx, opts: ImportFlowOptions): Promise<ResolvedBin> {
  return resolveCliRatelBin(ctx, {
    envVar: opts.envVar ?? process.env.RATEL_MCP_BIN,
    whichResult: opts.whichResult,
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
  });
}

function renderSummary(plan: ImportPlan, agentHostName: string): string {
  const lines: string[] = [];
  if (plan.summary.movedFromUser.length > 0) {
    lines.push(`user: ${plan.summary.movedFromUser.join(", ")}`);
  }
  if (plan.summary.movedFromProject.length > 0) {
    lines.push(`project: ${plan.summary.movedFromProject.join(", ")}`);
  }
  if (plan.summary.movedFromLocal.length > 0) {
    lines.push(`local: ${plan.summary.movedFromLocal.join(", ")}`);
  }
  if (plan.summary.skipped.length > 0) {
    lines.push("");
    lines.push("Not copied into Ratel:");
    for (const s of plan.summary.skipped) {
      lines.push(`  - ${s.name} (${s.scope}): ${s.reason}`);
    }
  }
  if (plan.summary.conflicts.length > 0) {
    lines.push("");
    lines.push(
      `Ratel import conflicts: ${plan.summary.conflicts.length} (${renderConflictStrategyName(
        plan.summary.conflictStrategy,
        agentHostName,
      )})`,
    );
  }
  if (plan.summary.overwrittenRatelEntries.length > 0) {
    lines.push("");
    lines.push(
      `Overwriting existing ${agentHostName} ratel-mcp entry at: ${plan.summary.overwrittenRatelEntries.join(
        ", ",
      )}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "(no changes)";
}

function renderConflicts(conflicts: readonly ImportConflict[], agentHostName: string): string {
  return conflicts
    .map((c) =>
      [
        `- ${c.name} (${c.scope})`,
        `  ${agentHostName} definition: ${summarizeEntry(c.incoming)}`,
        `  Existing Ratel definition: ${summarizeEntry(c.existing)}`,
      ].join("\n"),
    )
    .join("\n");
}

function summarizeEntry(entry: ServerEntry): string {
  if (entry.type === "http" || entry.type === "sse") {
    return `${entry.type} ${entry.url ?? "(missing url)"}`;
  }
  const command = entry.command ?? "(missing command)";
  const args = entry.args && entry.args.length > 0 ? ` ${entry.args.join(" ")}` : "";
  return `${entry.type ?? "stdio"} ${command}${args}`;
}

function renderConflictStrategyName(
  strategy: ImportConflictStrategy,
  agentHostName: string,
): string {
  if (strategy === "replace-from-agent")
    return `replace all Ratel definitions from ${agentHostName}`;
  if (strategy === "replace-selected") return "replace selected Ratel definitions";
  return "keep existing Ratel definitions";
}

function renderDiff(changes: readonly FileChange[]): string {
  return changes
    .map((c) => {
      if (c.kind !== "write") return `delete ${c.path}`;
      return `write ${c.path}${c.before === null ? " (new file)" : ""}`;
    })
    .join("\n");
}

function renderAgentStage(plan: ImportPlan, hostName = "agent"): string {
  const lines: string[] = [];
  lines.push(renderDiff(plan.agentChanges));
  lines.push("");
  lines.push(
    `${hostName} MCP entries now managed by Ratel will be replaced by a single ratel-mcp entry. Other ${hostName} MCP entries are preserved.`,
  );
  if (plan.summary.skipped.length > 0) {
    lines.push("");
    lines.push("Not copied into Ratel:");
    for (const s of plan.summary.skipped) {
      lines.push(`  - ${s.name} (${s.scope})`);
    }
  }
  return lines.join("\n");
}
