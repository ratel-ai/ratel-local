import type { BackupManifest, RatelConfig, ServerEntry } from "@ratel-ai/mcp-core";
import {
  type AgentHostState,
  type AgentImportWorkflowState,
  type AgentScope,
  AutomaticAgentHostAdapter,
  advanceAgentImportWorkflow,
  beginAgentImportWorkflow,
  buildAgentImportPlan,
  conflictKey,
  executePlan,
  type FileChange,
  getClaudeCodeStatuslineState,
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
  unlinkedAgentImportWarning,
} from "@ratel-ai/mcp-core";
import { ArgError } from "../args.js";
import { resolveCliRatelBin } from "../ratel-bin.js";
import {
  activateSkills,
  defaultSkillManagePaths,
  type SkillManagePaths,
  type SkillSource,
} from "../skills/manage.js";
import { runLink } from "./link.js";
import { runStatuslineInstallStep } from "./statusline.js";
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
  skillPaths?: SkillManagePaths;
  now?: () => Date;
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

interface SkillCandidate {
  id: string;
  source: SkillSource;
}

interface SkillPreview {
  candidates: SkillCandidate[];
  skipped: Array<{ id: string; reason: string }>;
}

interface SkillImportResult {
  managed: number;
  skipped: Array<{ id: string; reason: string }>;
}

type ConflictResolutionResult =
  | { kind: "resolved"; resolution: ConflictResolution }
  | { kind: "cancelled" };

export const IMPORT_USAGE = `usage: ratel-mcp import [flags]

Flags:
  --agent auto|claude-code|codex
                              choose the source agent (default: auto)
  --conflict-strategy add-missing-only|replace-selected|replace-from-agent
                              choose how matching Ratel definitions are handled
  --dry-run                   preview changes without writing files
  --yes                       accept non-interactive defaults
  --help                      show this help`;

export async function runImport(
  ctx: HandlerCtx,
  opts: ImportFlowOptions = {},
): Promise<BackupManifest | null> {
  ctx.prompts.intro("Ratel · import agent MCP servers and skills");

  const agentHost = opts.agentKind
    ? new NamedAgentHostAdapter(opts.agentKind)
    : new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  let agentState: AgentHostState | null = null;
  let candidates: Candidate[] = [];
  if (detection.present) {
    agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
    candidates = collectCandidates(agentState);
  }

  const skillPaths = opts.skillPaths ?? defaultSkillManagePaths(ctx.env.homeDir);
  const skillPreview = await previewSkillCandidates(skillPaths, {
    source: resolveSkillSource(opts.agentKind, agentState),
    now: opts.now,
  });

  if (!detection.present && skillPreview.candidates.length === 0) {
    ctx.prompts.note(
      "No supported agent MCP servers or native skills found at any scope. Nothing to import.",
    );
    ctx.prompts.outro("done");
    return null;
  }
  if (agentState && candidates.length === 0 && skillPreview.candidates.length === 0) {
    ctx.prompts.note(
      `No ${agentState.host.displayName} MCP servers or native skills found at any scope. Nothing to import.`,
    );
    ctx.prompts.outro("done");
    return null;
  }

  const workflowHostKind = resolveWorkflowHostKind(opts.agentKind, agentState);
  let linkCommitted = false;
  let workflow = workflowHostKind
    ? await beginCliImportWorkflow(ctx, workflowHostKind, agentState)
    : null;
  if (workflow?.step === "link") {
    const decision = opts.yes
      ? "link"
      : await selectUnlinkedAgentAction(ctx, detection.displayName);
    if (decision === "cancel") {
      ctx.prompts.cancel("import cancelled (no writes)");
      return null;
    }
    if (decision === "link") {
      if (opts.dryRun) {
        ctx.log(`would link ${detection.displayName} to Ratel before importing`);
      } else {
        const linkManifest = await runLink(ctx, {
          yes: true,
          bin: opts.bin,
          envVar: opts.envVar,
          whichResult: opts.whichResult,
          workspaceRoot: opts.workspaceRoot,
          agentKind: workflowHostKind ?? undefined,
          exists: opts.exists,
        });
        linkCommitted = linkManifest !== null;
        if (agentState) {
          agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
          candidates = collectCandidates(agentState);
        }
      }
      workflow = advanceAgentImportWorkflow(workflow, { type: "link-completed" });
    } else {
      workflow = advanceAgentImportWorkflow(workflow, { type: "link-skipped" });
    }
  }

  if (agentState) {
    ctx.prompts.note(renderDetectedAgentSources(agentState), "Detected agent");
  }
  if (skillPreview.candidates.length > 0 || skillPreview.skipped.length > 0) {
    ctx.prompts.note(renderDetectedSkills(skillPreview, skillPaths), "Detected skills");
  }

  const selection = candidates.length > 0 ? await selectCandidates(ctx, candidates, opts) : [];
  if (selection === null) {
    ctx.prompts.cancel("import cancelled");
    return null;
  }
  const selectedSkills = await selectSkillCandidates(ctx, skillPreview.candidates, opts);
  if (selectedSkills === null) {
    ctx.prompts.cancel("import cancelled");
    return null;
  }

  let plan: ImportPlan = emptyImportPlan();
  let bin: ResolvedBin | null = null;

  if (agentState && selection.length > 0) {
    await captureDescriptions(ctx, selection, agentState, opts);

    const ratelUserPath = ratelConfigPath("user", ctx.env);
    const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
    const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;

    bin = opts.bin ?? (await resolveBin(ctx, opts));

    const ratelUser = await readJson<RatelConfig>(ctx.fs, ratelUserPath);
    const ratelProject = ratelProjectPath
      ? await readJson<RatelConfig>(ctx.fs, ratelProjectPath)
      : null;
    const ratelLocal = ratelLocalPath ? await readJson<RatelConfig>(ctx.fs, ratelLocalPath) : null;

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
      ctx.prompts.cancel(importCancellationMessage(linkCommitted));
      return null;
    }

    plan = await buildAgentImportPlan(planInputs, {
      ...planOptions,
      ...conflictResolution.resolution,
    });
  }

  ctx.prompts.note(
    renderSummary(plan, agentState?.host.displayName ?? "agent", selectedSkills),
    "Summary",
  );

  if (
    plan.ratelChanges.length === 0 &&
    plan.agentChanges.length === 0 &&
    selectedSkills.length === 0
  ) {
    ctx.prompts.outro("nothing to do");
    return null;
  }

  if (opts.dryRun) {
    for (const c of [...plan.ratelChanges, ...plan.agentChanges]) {
      if (c.kind === "write") ctx.log(`would write ${c.path}`);
    }
    for (const skill of selectedSkills) {
      ctx.log(`would manage skill ${skill.id} (${skill.source}) as invoke-only`);
    }
    ctx.prompts.outro("dry-run complete");
    return null;
  }

  ctx.prompts.note(renderImportCommit(plan, selectedSkills), "Import commit");
  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: "Commit these import changes?",
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      ctx.prompts.cancel(importCancellationMessage(linkCommitted));
      return null;
    }
  }

  let latestManifest: BackupManifest | null = null;
  if (plan.ratelChanges.length > 0) {
    latestManifest = await tryExecute(ctx, plan.ratelChanges, "import");
  }
  if (plan.agentChanges.length > 0) {
    latestManifest = await tryExecute(ctx, plan.agentChanges, "import");
  }

  let skillImportResult: SkillImportResult = { managed: 0, skipped: [] };
  if (selectedSkills.length > 0) {
    skillImportResult = await activateSelectedSkills(ctx, skillPaths, selectedSkills, opts);
  }

  if (workflow?.step === "import") {
    workflow = advanceAgentImportWorkflow(workflow, { type: "import-completed" });
  }
  if (workflow?.step === "statusline") {
    bin ??= opts.bin ?? (await resolveBin(ctx, opts));
    const statuslineResult = await runStatuslineInstallStep(ctx, { bin, yes: opts.yes });
    workflow = advanceAgentImportWorkflow(workflow, {
      type: statuslineResult === "skipped" ? "statusline-skipped" : "statusline-installed",
    });
  }

  if (latestManifest) {
    ctx.prompts.note(`Backup created. Run \`ratel-mcp backup list\` to inspect backups.`, "Done");
  }
  ctx.prompts.outro(renderCompletion(agentState, plan, skillImportResult.managed));
  return latestManifest;
}

async function beginCliImportWorkflow(
  ctx: HandlerCtx,
  hostKind: SupportedAgentHostKind,
  agentState: AgentHostState | null,
): Promise<AgentImportWorkflowState> {
  const linked = agentState ? isAgentStateLinked(agentState) : true;
  const statuslineInstalled =
    hostKind === "claude-code"
      ? (await getClaudeCodeStatuslineState(ctx)).status === "installed"
      : false;
  return beginAgentImportWorkflow({ hostKind, linked, statuslineInstalled });
}

function resolveWorkflowHostKind(
  requested: SupportedAgentHostKind | undefined,
  state: AgentHostState | null,
): SupportedAgentHostKind | null {
  if (requested) return requested;
  return state?.host.kind === "claude-code" || state?.host.kind === "codex"
    ? state.host.kind
    : null;
}

function isAgentStateLinked(state: AgentHostState): boolean {
  return state.scopes.some((scope) =>
    Object.entries(scope.mcpServers).some(([name, entry]) => isRatelGatewayEntry(name, entry)),
  );
}

async function selectUnlinkedAgentAction(
  ctx: HandlerCtx,
  agentDisplayName: string,
): Promise<"link" | "skip" | "cancel"> {
  ctx.prompts.note(unlinkedAgentImportWarning(agentDisplayName), "Agent not linked");
  const answer = await ctx.prompts.select<"link" | "skip" | "cancel">({
    message: "Link Ratel before importing?",
    options: [
      {
        value: "link" as const,
        label: "Link Ratel and continue",
        hint: "Recommended; keeps imported MCPs and skills usable in this agent.",
      },
      {
        value: "skip" as const,
        label: "Continue without linking",
        hint: "Import for use through another linked agent.",
      },
      { value: "cancel" as const, label: "Cancel import" },
    ],
    initialValue: "link",
  });
  if (ctx.prompts.isCancel(answer)) return "cancel";
  return answer as "link" | "skip" | "cancel";
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

function resolveSkillSource(
  agentKind: SupportedAgentHostKind | undefined,
  state: AgentHostState | null,
): SkillSource | undefined {
  if (agentKind) return skillSourceForAgentKind(agentKind);
  return skillSourceForAgentKind(state?.host.kind);
}

function skillSourceForAgentKind(kind: string | undefined): SkillSource | undefined {
  if (kind === "claude-code") return "claude";
  if (kind === "codex") return "codex";
  return undefined;
}

async function previewSkillCandidates(
  paths: SkillManagePaths,
  opts: { source?: SkillSource; now?: () => Date },
): Promise<SkillPreview> {
  const result = await activateSkills(paths, {
    dryRun: true,
    source: opts.source,
    now: opts.now,
  });
  return {
    candidates: result.managed.map((entry) => ({
      id: entry.id,
      source: entry.source ?? "claude",
    })),
    skipped: result.skipped,
  };
}

async function selectSkillCandidates(
  ctx: HandlerCtx,
  candidates: SkillCandidate[],
  opts: ImportFlowOptions,
): Promise<SkillCandidate[] | null> {
  if (candidates.length === 0) return [];
  if (opts.yes) return candidates;
  const picked = await ctx.prompts.multiselect<string>({
    message: "Pick native skills to manage through Ratel",
    options: candidates.map((skill) => ({
      value: skillTagOf(skill),
      label: `${skill.id} [${sourceLabel(skill.source)}]`,
      hint: "Managed as invoke-only; native folder stays in place.",
    })),
    initialValues: candidates.map(skillTagOf),
    required: false,
  });
  if (ctx.prompts.isCancel(picked)) return null;
  const selected = new Set(picked as string[]);
  return candidates.filter((skill) => selected.has(skillTagOf(skill)));
}

async function activateSelectedSkills(
  ctx: HandlerCtx,
  paths: SkillManagePaths,
  skills: SkillCandidate[],
  opts: ImportFlowOptions,
): Promise<SkillImportResult> {
  const idsBySource = new Map<SkillSource, string[]>();
  for (const skill of skills) {
    const ids = idsBySource.get(skill.source) ?? [];
    ids.push(skill.id);
    idsBySource.set(skill.source, ids);
  }
  const skipped: Array<{ id: string; reason: string }> = [];
  let managed = 0;
  for (const [source, ids] of idsBySource) {
    const result = await activateSkills(paths, {
      ids,
      source,
      logger: ctx.log,
      now: opts.now,
    });
    managed += result.managed.length;
    skipped.push(...result.skipped);
  }
  ctx.log(`managing ${managed} skill${managed === 1 ? "" : "s"} as invoke-only`);
  if (skipped.length > 0) {
    ctx.log(`warning: ${skippedSkillsMessage(skipped)}`);
  }
  return { managed, skipped };
}

function skippedSkillsMessage(skipped: Array<{ id: string; reason: string }>): string {
  const details = skipped.map((s) => `${s.id}: ${s.reason}`).join("; ");
  return `could not manage selected skill${skipped.length === 1 ? "" : "s"} (${details})`;
}

function importCancellationMessage(linkCommitted: boolean): string {
  return linkCommitted ? "import cancelled · link retained" : "import cancelled (no writes)";
}

function skillTagOf(skill: SkillCandidate): string {
  return `${skill.source}:${skill.id}`;
}

function sourceLabel(source: SkillSource): string {
  return source === "codex" ? "Codex" : "Claude Code";
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

function renderDetectedSkills(preview: SkillPreview, paths: SkillManagePaths): string {
  const lines: string[] = [];
  const bySource = new Map<SkillSource, SkillCandidate[]>();
  for (const skill of preview.candidates) {
    const skills = bySource.get(skill.source) ?? [];
    skills.push(skill);
    bySource.set(skill.source, skills);
  }
  for (const source of ["claude", "codex"] as const) {
    const skills = bySource.get(source) ?? [];
    if (skills.length === 0) continue;
    const dir = source === "claude" ? paths.nativeDir : paths.codexDir;
    lines.push(
      `- ${sourceLabel(source)}: ${dir} (${skills.length} skill${skills.length === 1 ? "" : "s"})`,
    );
  }
  if (preview.skipped.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Already managed or skipped:");
    for (const skipped of preview.skipped) {
      lines.push(`  - ${skipped.id}: ${skipped.reason}`);
    }
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

function emptyImportPlan(): ImportPlan {
  return {
    ratelChanges: [],
    agentChanges: [],
    summary: {
      movedFromUser: [],
      movedFromProject: [],
      movedFromLocal: [],
      replacedFromUser: [],
      replacedFromProject: [],
      replacedFromLocal: [],
      skipped: [],
      conflicts: [],
      conflictStrategy: "add-missing-only",
      ratelEntryArgsByScope: {},
      overwrittenRatelEntries: [],
    },
  };
}

function renderSummary(
  plan: ImportPlan,
  agentHostName: string,
  selectedSkills: readonly SkillCandidate[],
): string {
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
  if (selectedSkills.length > 0) {
    lines.push("");
    lines.push("Skills to manage:");
    for (const skill of selectedSkills) {
      lines.push(`  - ${skill.id} (${sourceLabel(skill.source)})`);
    }
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

function renderImportCommit(plan: ImportPlan, skills: readonly SkillCandidate[]): string {
  const sections: string[] = [];
  if (plan.ratelChanges.length > 0) {
    sections.push(`Ratel config\n${renderDiff(plan.ratelChanges)}`);
  }
  if (plan.agentChanges.length > 0) {
    sections.push(`Source agent cleanup\n${renderDiff(plan.agentChanges)}`);
  }
  if (skills.length > 0) sections.push(`Skills\n${renderSkillStage(skills)}`);
  return sections.join("\n\n");
}

function renderSkillStage(skills: readonly SkillCandidate[]): string {
  return skills
    .map((skill) => `manage ${skill.id} (${sourceLabel(skill.source)}) as invoke-only`)
    .join("\n");
}

function renderCompletion(
  agentState: AgentHostState | null,
  plan: ImportPlan,
  managedSkillCount: number,
): string {
  const parts: string[] = ["import complete"];
  if (agentState && plan.agentChanges.length > 0) {
    parts.push(`${agentState.host.displayName} source entries removed`);
  } else if (agentState && plan.ratelChanges.length > 0) {
    parts.push(`no ${agentState.host.displayName} changes needed`);
  }
  if (managedSkillCount > 0) {
    parts.push(
      `managing ${managedSkillCount} skill${managedSkillCount === 1 ? "" : "s"} as invoke-only`,
    );
  }
  return parts.join(" · ");
}
