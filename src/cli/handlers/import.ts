import type { RatelConfig, ServerEntry } from "../../lib/index.js";
import { ArgError } from "../args.js";
import type { BackupManifest } from "../backup.js";
import { type ClaudeConfigDoc, type ClaudeScope, readClaudeConfig } from "../claude.js";
import { ratelConfigPath } from "../hierarchy.js";
import {
  buildImportPlan,
  conflictKey,
  type FileChange,
  type ImportConflict,
  type ImportConflictStrategy,
  type ImportPlan,
} from "../import-plan.js";
import { readJson } from "../io.js";
import { locateRatelBin, type ResolvedBin } from "../locate-bin.js";
import { executePlan } from "../plan-exec.js";
import { probeEntryInstructions } from "../probe.js";
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
  exists?: (path: string) => Promise<boolean>;
  probe?: ProbeFn;
}

interface Candidate {
  name: string;
  scope: ClaudeScope;
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
  ctx.prompts.intro("Ratel · import Claude Code MCP servers");

  const claudeUser = await readClaudeConfig("user", ctx.env, ctx.fs);
  const claudeProject = ctx.env.projectRoot
    ? await readClaudeConfig("project", ctx.env, ctx.fs)
    : null;
  const claudeLocal = ctx.env.projectRoot ? await readClaudeConfig("local", ctx.env, ctx.fs) : null;

  const candidates = collectCandidates(claudeUser, claudeProject, claudeLocal);
  if (candidates.length === 0) {
    ctx.prompts.note("No Claude Code MCP servers found at any scope. Nothing to import.");
    ctx.prompts.outro("done");
    return null;
  }

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

  await captureDescriptions(ctx, selection, claudeUser, claudeProject, claudeLocal, opts);

  const planInputs = {
    claudeUser,
    claudeProject,
    claudeLocal,
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
  const initialPlan = buildImportPlan(planInputs, planOptions);
  const conflictResolution = await resolveConflictStrategy(ctx, initialPlan, opts);
  if (conflictResolution.kind === "cancelled") {
    ctx.prompts.cancel("import cancelled (no writes)");
    return null;
  }

  const plan = buildImportPlan(planInputs, { ...planOptions, ...conflictResolution.resolution });

  ctx.prompts.note(renderSummary(plan), "Summary");

  if (plan.ratelChanges.length === 0 && plan.claudeChanges.length === 0) {
    ctx.prompts.outro("nothing to do");
    return null;
  }

  if (opts.dryRun) {
    for (const c of [...plan.ratelChanges, ...plan.claudeChanges]) {
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

  if (plan.claudeChanges.length === 0) {
    ctx.prompts.outro("import complete · no Claude changes needed");
    return stageAManifest;
  }

  ctx.prompts.note(renderClaudeStage(plan), "Claude Code config changes");
  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: "Replace Claude Code MCP entries now managed by Ratel with the ratel-mcp entry?",
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      ctx.log(
        "Claude Code config changes skipped. Run `ratel-mcp link` (or re-run `ratel-mcp import`) to point Claude at Ratel later.",
      );
      ctx.prompts.outro("Ratel config changes applied · Claude Code config changes skipped");
      return stageAManifest;
    }
  }

  const stageBManifest = await tryExecute(ctx, plan.claudeChanges, "import");
  ctx.prompts.note(`Backup created. Run \`ratel-mcp backup undo\` to revert.`, "Done");
  ctx.prompts.outro("import complete · restart Claude to pick up the new MCP entry");
  return stageBManifest;
}

async function resolveConflictStrategy(
  ctx: HandlerCtx,
  plan: ImportPlan,
  opts: ImportFlowOptions,
): Promise<ConflictResolutionResult> {
  if (plan.summary.conflicts.length === 0) {
    return { kind: "resolved", resolution: { conflictStrategy: "add-missing-only" } };
  }
  ctx.prompts.note(renderConflicts(plan.summary.conflicts), "Ratel import conflicts");
  if (opts.conflictStrategy) {
    if (opts.conflictStrategy === "replace-selected" && (opts.yes || opts.dryRun)) {
      throw new ArgError(
        "--conflict-strategy replace-selected cannot be combined with --yes or --dry-run",
      );
    }
    return resolveSelectedConflicts(ctx, plan, opts.conflictStrategy);
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
    options: conflictStrategyOptions(plan.summary.conflicts.length),
  });
  if (ctx.prompts.isCancel(picked) || picked === "cancel") return { kind: "cancelled" };
  return resolveSelectedConflicts(ctx, plan, picked as ImportConflictStrategy);
}

async function resolveSelectedConflicts(
  ctx: HandlerCtx,
  plan: ImportPlan,
  conflictStrategy: ImportConflictStrategy,
): Promise<ConflictResolutionResult> {
  if (conflictStrategy !== "replace-selected") {
    return { kind: "resolved", resolution: { conflictStrategy } };
  }

  const selected = await ctx.prompts.multiselect<string>({
    message: "Pick Ratel entries to replace from Claude Code",
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

function conflictStrategyOptions(conflictCount: number) {
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
          ? "Do not import the conflicting Claude Code definition."
          : "Do not import the conflicting Claude Code definitions.",
    },
  ];
  if (conflictCount > 1) {
    options.push({
      value: "replace-selected",
      label: "Replace selected Ratel definitions",
      hint: "Choose which existing Ratel definitions to overwrite with Claude Code definitions.",
    });
  }
  options.push(
    {
      value: "replace-from-agent",
      label:
        conflictCount === 1
          ? "Replace Ratel definition from Claude Code"
          : "Replace all Ratel definitions from Claude Code",
      hint:
        conflictCount === 1
          ? "Overwrite the existing Ratel definition with the Claude Code definition."
          : "Overwrite each existing Ratel definition with its Claude Code definition.",
    },
    {
      value: "cancel",
      label: "Cancel",
      hint: "Exit before writing files.",
    },
  );
  return options;
}

function collectCandidates(
  user: ClaudeConfigDoc | null,
  project: ClaudeConfigDoc | null,
  local: ClaudeConfigDoc | null,
): Candidate[] {
  const out: Candidate[] = [];
  for (const [scope, doc] of [
    ["user", user],
    ["project", project],
    ["local", local],
  ] as const) {
    if (!doc) continue;
    for (const [name, entry] of Object.entries(doc.mcpServers)) {
      if (name === "ratel" || name === "ratel-mcp") continue;
      out.push({ name, scope, hasDescription: typeof entry.description === "string" });
    }
  }
  return out;
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
  user: ClaudeConfigDoc | null,
  project: ClaudeConfigDoc | null,
  local: ClaudeConfigDoc | null,
  opts: ImportFlowOptions,
): Promise<void> {
  if (opts.yes) return;
  const docByScope: Record<ClaudeScope, ClaudeConfigDoc | null> = { user, project, local };
  const targets = selected
    .filter((c) => !c.hasDescription)
    .map((c) => ({ c, entry: docByScope[c.scope]?.mcpServers[c.name] }))
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
    ctx.log(
      `partial backup may exist under ~/.ratel/backups/. Run \`ratel-mcp backup undo\` to revert.`,
    );
    throw err;
  }
}

async function resolveBin(ctx: HandlerCtx, opts: ImportFlowOptions): Promise<ResolvedBin> {
  return locateRatelBin({
    envVar: opts.envVar ?? process.env.RATEL_MCP_BIN,
    whichResult: opts.whichResult ?? (await whichRatelBin()),
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
    promptForPath: async () => {
      const v = await ctx.prompts.text({
        message: "Path to ratel-mcp binary?",
      });
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

function renderSummary(plan: ImportPlan): string {
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
      )})`,
    );
  }
  if (plan.summary.overwrittenRatelEntries.length > 0) {
    lines.push("");
    lines.push(
      `Overwriting existing Claude ratel-mcp entry at: ${plan.summary.overwrittenRatelEntries.join(
        ", ",
      )}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "(no changes)";
}

function renderConflicts(conflicts: readonly ImportConflict[]): string {
  return conflicts
    .map((c) =>
      [
        `- ${c.name} (${c.scope})`,
        `  Claude Code definition: ${summarizeEntry(c.incoming)}`,
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

function renderConflictStrategyName(strategy: ImportConflictStrategy): string {
  if (strategy === "replace-from-agent") return "replace all Ratel definitions from Claude Code";
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

function renderClaudeStage(plan: ImportPlan): string {
  const lines: string[] = [];
  lines.push(renderDiff(plan.claudeChanges));
  lines.push("");
  lines.push(
    "Claude Code MCP entries now managed by Ratel will be replaced by a single ratel-mcp entry. Other Claude Code MCP entries are preserved.",
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
