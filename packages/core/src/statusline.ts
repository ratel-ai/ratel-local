import { join } from "node:path";
import { ClaudeCodeAgentHostAdapter } from "./agent-host/claude-code.js";
import type { AgentHostState } from "./agent-host/index.js";
import { getAgentHostRatelConnection } from "./agent-host/ratel-connection.js";
import { type BackupFs, type BackupManifest, startBackup } from "./backup.js";
import type { HierarchyEnv } from "./hierarchy.js";
import type { JsonFs } from "./io.js";
import { writeJson } from "./io.js";
import { isPlainObject, stableJsonStringify } from "./json.js";
import type { ResolvedBin } from "./locate-bin.js";
import {
  readLatestToolTokenEstimates,
  summarizeToolTokenEstimates,
  type ToolTokenEstimateSummary,
} from "./telemetry.js";

export type ClaudeStatuslineInstallStatus = "not-installed" | "installed" | "other";

export interface ClaudeCodeStatuslineState {
  settingsPath: string;
  status: ClaudeStatuslineInstallStatus;
  installed: boolean;
  ownedByRatel: boolean;
  command: string | null;
  ratelEnabled: boolean;
  ratelEnabledSources: string[];
  warnings: string[];
}

export interface ClaudeStatuslineInstallResult {
  changed: boolean;
  path: string;
  command: string;
  manifest: BackupManifest | null;
  state: ClaudeCodeStatuslineState;
}

export interface ClaudeStatuslineUninstallResult {
  changed: boolean;
  path: string;
  manifest: BackupManifest | null;
  state: ClaudeCodeStatuslineState;
}

export interface RenderRatelStatuslineOptions {
  telemetryDir?: string;
  gitBranch?: string | null;
}

export interface StatuslineContext {
  env: HierarchyEnv;
  fs: JsonFs & BackupFs;
  log?: (message: string) => void;
}

export class ClaudeStatuslineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeStatuslineConflictError";
  }
}

const ANSI = {
  amber: "\u001b[38;5;178m",
  cyan: "\u001b[38;5;80m",
  dim: "\u001b[2m",
  green: "\u001b[38;5;72m",
  gray: "\u001b[38;5;245m",
  reset: "\u001b[0m",
};

export function claudeCodeUserSettingsPath(env: Pick<HierarchyEnv, "homeDir">): string {
  return join(env.homeDir, ".claude", "settings.json");
}

export function claudeCodeStatuslineCommand(bin: ResolvedBin): string {
  return [bin.command, ...bin.args, "statusline"].map(shellQuote).join(" ");
}

export function isRatelOwnedStatusline(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.type !== "command") return false;
  const command = value.command;
  const ratelShape = value.padding === 0 && value.refreshInterval === 30;
  return typeof command === "string" && isRatelStatuslineCommand(command, ratelShape);
}

export async function getClaudeCodeStatuslineState(
  ctx: StatuslineContext,
): Promise<ClaudeCodeStatuslineState> {
  const settingsPath = claudeCodeUserSettingsPath(ctx.env);
  const warnings: string[] = [];
  const settings = await readSettingsLenient(ctx, settingsPath, warnings);
  const current = settings?.statusLine;
  const ownedByRatel = isRatelOwnedStatusline(current);
  const command =
    isPlainObject(current) && typeof current.command === "string" ? current.command : null;
  const status: ClaudeStatuslineInstallStatus =
    current === undefined || current === null
      ? "not-installed"
      : ownedByRatel
        ? "installed"
        : "other";
  const ratel = await detectClaudeRatelEnabled(ctx, warnings);
  return {
    settingsPath,
    status,
    installed: status === "installed",
    ownedByRatel,
    command,
    ratelEnabled: ratel.enabled,
    ratelEnabledSources: ratel.sources,
    warnings,
  };
}

export async function installClaudeCodeStatusline(
  ctx: StatuslineContext,
  input: { bin: ResolvedBin; force?: boolean; now?: () => Date },
): Promise<ClaudeStatuslineInstallResult> {
  const path = claudeCodeUserSettingsPath(ctx.env);
  const current = (await readSettingsStrict(ctx, path)) ?? {};
  const existing = current.statusLine;
  if (
    existing !== undefined &&
    existing !== null &&
    !isRatelOwnedStatusline(existing) &&
    !input.force
  ) {
    throw new ClaudeStatuslineConflictError(
      `Claude Code already has a non-Ratel statusLine configured at ${path}; rerun with --force to replace it.`,
    );
  }

  const command = claudeCodeStatuslineCommand(input.bin);
  const target = {
    type: "command",
    command,
    padding: 0,
    refreshInterval: 30,
  };
  if (sameJson(existing, target)) {
    return {
      changed: false,
      path,
      command,
      manifest: null,
      state: await getClaudeCodeStatuslineState(ctx),
    };
  }

  const next = { ...current, statusLine: target };
  const session = startBackup(ctx.env, ctx.fs, input.now);
  await session.capture(path);
  const manifest = await session.finalize("edit");
  await writeJson(ctx.fs, path, next);
  return {
    changed: true,
    path,
    command,
    manifest,
    state: await getClaudeCodeStatuslineState(ctx),
  };
}

export async function uninstallClaudeCodeStatusline(
  ctx: StatuslineContext,
  input: { now?: () => Date } = {},
): Promise<ClaudeStatuslineUninstallResult> {
  const path = claudeCodeUserSettingsPath(ctx.env);
  const current = await readSettingsStrict(ctx, path);
  if (!current || !isRatelOwnedStatusline(current.statusLine)) {
    return {
      changed: false,
      path,
      manifest: null,
      state: await getClaudeCodeStatuslineState(ctx),
    };
  }

  const next = { ...current };
  delete next.statusLine;
  const session = startBackup(ctx.env, ctx.fs, input.now);
  await session.capture(path);
  const manifest = await session.finalize("edit");
  await writeJson(ctx.fs, path, next);
  return {
    changed: true,
    path,
    manifest,
    state: await getClaudeCodeStatuslineState(ctx),
  };
}

export async function renderRatelStatusline(
  ctx: StatuslineContext,
  stdinJson: string,
  opts: RenderRatelStatuslineOptions = {},
): Promise<string> {
  try {
    const payload = parseClaudeStatuslineInput(stdinJson);
    const state = await getClaudeCodeStatuslineState(ctx);
    const usage = await readLatestToolTokenEstimates(ctx, {
      projectDir: payload.projectDir,
      telemetryDir: opts.telemetryDir,
    });
    const telemetry = summarizeToolTokenEstimates(usage.byServer);
    return renderStatusline(payload, state, telemetry, opts);
  } catch (err) {
    ctx.log?.(`[ratel] statusline failed open: ${(err as Error).message}`);
    return `${ANSI.gray}○ Claude statusline loading${ANSI.reset}\n${ANSI.gray}Ratel telemetry unavailable${ANSI.reset}\n`;
  }
}

interface ParsedClaudeStatuslineInput {
  model: string;
  projectDir: string | null;
  contextSize: number | null;
  usedTokens: number | null;
  usedPercent: number | null;
  durationMs: number | null;
  branch: string | null;
}

function parseClaudeStatuslineInput(stdinJson: string): ParsedClaudeStatuslineInput {
  const raw = stdinJson.trim().length > 0 ? JSON.parse(stdinJson) : {};
  if (!isPlainObject(raw)) throw new Error("statusline stdin must be a JSON object");
  const modelObj = objectAt(raw, "model");
  const workspace = objectAt(raw, "workspace");
  const contextWindow = objectAt(raw, "context_window");
  const cost = objectAt(raw, "cost");
  const worktree = objectAt(raw, "worktree");

  const contextSize = numberAt(contextWindow, "context_window_size");
  const usedPercent = numberAt(contextWindow, "used_percentage");
  const currentUsage = contextWindow.current_usage;
  const usedTokens =
    numericUsage(currentUsage) ??
    (contextSize !== null && usedPercent !== null
      ? Math.round((contextSize * Math.max(0, usedPercent)) / 100)
      : null);

  return {
    model: stringAt(modelObj, "display_name") ?? stringAt(modelObj, "id") ?? "Claude",
    projectDir: stringAt(workspace, "project_dir") ?? stringAt(workspace, "current_dir"),
    contextSize,
    usedTokens,
    usedPercent:
      usedPercent ??
      (usedTokens !== null && contextSize && contextSize > 0
        ? (usedTokens / contextSize) * 100
        : null),
    durationMs: numberAt(cost, "total_duration_ms"),
    branch: stringAt(worktree, "branch"),
  };
}

function renderStatusline(
  input: ParsedClaudeStatuslineInput,
  state: ClaudeCodeStatuslineState,
  telemetry: ToolTokenEstimateSummary,
  opts: RenderRatelStatuslineOptions,
): string {
  const dot = state.ratelEnabled ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.amber}○${ANSI.reset}`;
  const context = formatContext(input);
  const duration = input.durationMs === null ? "now" : formatDuration(input.durationMs);
  const branch = opts.gitBranch ?? input.branch;
  const branchText = branch ? `  ⎇ ${branch}` : "";
  const line1 = `${dot} ${ANSI.cyan}${input.model}${ANSI.reset}  ${context}  ${duration}${branchText}`;
  const line2 = `${contextBar(input.usedPercent)} ${formatRatelMode(state)}  ${formatTelemetryNote(
    state,
    telemetry,
  )}`;
  return `${line1}\n${line2}\n`;
}

function formatContext(input: ParsedClaudeStatuslineInput): string {
  if (input.usedTokens === null || input.contextSize === null)
    return `${ANSI.gray}context loading${ANSI.reset}`;
  const pct = input.usedPercent === null ? "?" : `${Math.round(input.usedPercent)}%`;
  return `${formatTokenCount(input.usedTokens)} / ${formatTokenCount(input.contextSize)} · ${pct}`;
}

function formatRatelMode(state: ClaudeCodeStatuslineState): string {
  if (state.ratelEnabled) return `${ANSI.green}Ratel on${ANSI.reset}`;
  return `${ANSI.amber}Ratel not enabled${ANSI.reset}`;
}

function formatTelemetryNote(
  state: ClaudeCodeStatuslineState,
  telemetry: ToolTokenEstimateSummary,
): string {
  if (!telemetry.hasData) {
    return `${ANSI.gray}waiting for Ratel telemetry${ANSI.reset}`;
  }
  const verb = state.ratelEnabled ? "saves" : "could trim";
  return `${verb} ~${formatTokenCount(telemetry.estimatedTokens)} (${telemetry.toolCount} tools)`;
}

function contextBar(percent: number | null): string {
  const width = 18;
  const ratio = percent === null ? 0 : Math.max(0, Math.min(1, percent / 100));
  const filled = Math.round(width * ratio);
  const color = ratio >= 0.75 ? ANSI.amber : ANSI.green;
  return `${color}${"█".repeat(filled)}${ANSI.gray}${"░".repeat(width - filled)}${ANSI.reset}`;
}

async function detectClaudeRatelEnabled(
  ctx: StatuslineContext,
  warnings: string[],
): Promise<{ enabled: boolean; sources: string[] }> {
  let state: AgentHostState | null = null;
  try {
    state = await new ClaudeCodeAgentHostAdapter().read({ env: ctx.env, fs: ctx.fs });
  } catch (err) {
    warnings.push(`Failed to read Claude MCP config: ${(err as Error).message}`);
  }
  const connection = await getAgentHostRatelConnection("claude-code", state, ctx, warnings);
  const sources = [
    ...(connection.explicit ? ["mcp-config"] : []),
    ...(connection.plugin ? ["plugin"] : []),
  ];
  return { enabled: connection.linked, sources };
}

async function readSettingsStrict(
  ctx: StatuslineContext,
  path: string,
): Promise<Record<string, unknown> | null> {
  const text = await ctx.fs.read(path);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${path}: root must be a JSON object`);
  return parsed;
}

async function readSettingsLenient(
  ctx: StatuslineContext,
  path: string,
  warnings: string[],
): Promise<Record<string, unknown> | null> {
  try {
    return await readSettingsStrict(ctx, path);
  } catch (err) {
    warnings.push(`Failed to read ${path}: ${(err as Error).message}`);
    return null;
  }
}

function numericUsage(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isPlainObject(value)) return null;
  let total = 0;
  let found = false;
  for (const item of Object.values(value)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      total += item;
      found = true;
    }
  }
  return found ? total : null;
}

function numberAt(value: Record<string, unknown>, key: string): number | null {
  return numberValue(value[key]);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringAt(value: Record<string, unknown>, key: string): string | null {
  const v = value[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = value[key];
  return isPlainObject(v) ? v : {};
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

function formatTokenCount(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
  return String(value);
}

function trimNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRatelStatuslineCommand(command: string, ratelShape: boolean): boolean {
  const lower = command.toLowerCase();
  return lower.includes("statusline") && (lower.includes("ratel") || ratelShape);
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJsonStringify(a) === stableJsonStringify(b);
}
