import { type SpawnOptions, spawn } from "node:child_process";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AuthFlowResult,
  addServerEntry,
  applyAgentImportAgent,
  applyAgentImportRatel,
  applyAgentLink,
  assertRatelScope,
  authorizeServer,
  editServerEntry,
  getAgentHostsState,
  getConfigState,
  type ImportConflictStrategy,
  importAgentServers,
  linkAgentToRatel,
  loadSkills,
  parseSkillMd,
  previewAgentImport,
  previewAgentLink,
  removeServerEntry,
  type ServerEntry,
  type SupportedAgentHostKind,
} from "@ratel-ai/mcp-core";
import type { HandlerCtx } from "../cli/handlers/types.js";
import { activateSkills, deactivateSkills, defaultSkillManagePaths } from "../cli/skills/manage.js";

export interface ApiResponse {
  status: number;
  body: unknown;
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function withCapture<T>(
  base: HandlerCtx,
  fn: (ctx: HandlerCtx) => Promise<T>,
): Promise<{ result: T; log: string[] }> {
  const log: string[] = [];
  const ctx: HandlerCtx = {
    ...base,
    log: (m) => log.push(m),
  };
  return fn(ctx).then((result) => ({ result, log }));
}

export async function getConfig(ctx: HandlerCtx): Promise<ApiResponse> {
  return ok(await getConfigState(ctx));
}

export async function getAgentHosts(ctx: HandlerCtx): Promise<ApiResponse> {
  return ok(await getAgentHostsState(ctx));
}

/**
 * The skills Ratel serves (under the managed folder `~/.ratel/skills`) plus the
 * Claude Code skills available to activate (under `~/.claude/skills`, not yet
 * managed). Loaded the same way the gateway loads them.
 */
export async function getSkills(ctx: HandlerCtx): Promise<ApiResponse> {
  const { managedDir, nativeDir } = defaultSkillManagePaths(ctx.env.homeDir);
  const problems: Array<{ id: string; where: "managed" | "available"; reason: string }> = [];
  const managed = await loadSkills([managedDir], {
    logger: ctx.log,
    onProblem: (p) => problems.push({ ...p, where: "managed" }),
  });
  const managedIds = new Set(managed.map((s) => s.id));
  const native = await loadSkills([nativeDir], {
    logger: ctx.log,
    onProblem: (p) => problems.push({ ...p, where: "available" }),
  });
  const available = native.filter((s) => !managedIds.has(s.id));
  return ok({
    managedDir,
    nativeDir,
    managed: managed.map(skillSummary),
    available: available.map(skillSummary),
    problems,
  });
}

function skillSummary(s: { id: string; name: string; description: string; tags?: string[] }) {
  return { id: s.id, name: s.name, description: s.description, tags: s.tags ?? [] };
}

interface FoundSkill {
  /** Absolute path to the skill's `SKILL.md`. */
  filePath: string;
  state: "active" | "available";
  parsed: ReturnType<typeof parseSkillMd>;
}

/**
 * Locate the `SKILL.md` backing a skill `id` (its frontmatter `name`). Managed
 * (active) skills take precedence over native (available) ones, mirroring how
 * the gateway resolves duplicates. Fail-soft per skill — a malformed `SKILL.md`
 * is skipped rather than aborting the scan. Returns null when nothing matches.
 */
async function findSkillFile(homeDir: string, id: string): Promise<FoundSkill | null> {
  const { managedDir, nativeDir } = defaultSkillManagePaths(homeDir);
  const sources: Array<{ dir: string; state: "active" | "available" }> = [
    { dir: managedDir, state: "active" },
    { dir: nativeDir, state: "available" },
  ];
  for (const { dir, state } of sources) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = join(dir, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = parseSkillMd(raw, filePath);
        if (parsed.name === id) return { filePath, state, parsed };
      } catch {
        // Malformed frontmatter — skip, matching loadSkills' fail-soft behaviour.
      }
    }
  }
  return null;
}

/**
 * Full detail of a single skill, by id. Returns the *author* body straight from
 * the `SKILL.md` (without the absolute-path bundled-resources index that
 * loadSkills appends for dispatch) so the editor round-trips cleanly.
 */
export async function getSkill(ctx: HandlerCtx, id: string): Promise<ApiResponse> {
  const found = await findSkillFile(ctx.env.homeDir, id);
  if (!found) return { status: 404, body: { error: `unknown skill: ${id}`, isError: true } };
  const { parsed, state } = found;
  return ok({
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    // Mirror the list view: triggers and tags are both indexed phrases.
    tags: [...parsed.tags, ...parsed.triggers],
    body: parsed.body,
    state,
  });
}

/** Move skills into the Ratel-managed folder. `ids` omitted = activate all. */
export async function activateSkillsRoute(
  ctx: HandlerCtx,
  body: { ids?: unknown },
): Promise<ApiResponse> {
  const ids = optionalStringArray(body.ids, "ids");
  const result = await activateSkills(defaultSkillManagePaths(ctx.env.homeDir), {
    ids,
    logger: ctx.log,
  });
  return ok({ moved: result.moved.map((m) => m.id), skipped: result.skipped });
}

/** Restore managed skills back to `~/.claude/skills`. `ids` omitted = deactivate all. */
export async function deactivateSkillsRoute(
  ctx: HandlerCtx,
  body: { ids?: unknown },
): Promise<ApiResponse> {
  const ids = optionalStringArray(body.ids, "ids");
  const result = await deactivateSkills(defaultSkillManagePaths(ctx.env.homeDir), {
    ids,
    logger: ctx.log,
  });
  return ok({ restored: result.restored.map((m) => m.id), skipped: result.skipped });
}

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Create a new skill in the Ratel-managed folder by writing a `SKILL.md`. The
 * name must be a single safe path segment (no traversal); refuses to overwrite
 * an existing skill.
 */
export async function createSkillRoute(
  ctx: HandlerCtx,
  body: { name?: unknown; description?: unknown; tags?: unknown; body?: unknown },
): Promise<ApiResponse> {
  const name = requiredString(body.name, "name").trim();
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new Error("name must be a single segment of letters, digits, and hyphens");
  }
  const description = requiredString(body.description, "description");
  const tags = optionalStringArray(body.tags, "tags") ?? [];
  const skillBody = typeof body.body === "string" ? body.body : "";

  const { managedDir } = defaultSkillManagePaths(ctx.env.homeDir);
  const skillDir = join(managedDir, name);
  if (existsSync(join(skillDir, "SKILL.md"))) {
    throw new Error(`a skill named "${name}" already exists`);
  }
  const contents = buildSkillMd({ name, description, tags, body: skillBody });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), contents, "utf8");
  return ok({ created: name });
}

/**
 * Overwrite an existing skill's `SKILL.md` in place. The skill's `name` and
 * location are fixed (renaming would move the directory and break the manifest)
 * — only description, tags, and body change. `stacks` are preserved; `triggers`
 * fold into `tags`, since both are indexed phrases. Edits to a native skill
 * under `~/.claude/skills` write back to that same file.
 */
export async function updateSkillRoute(
  ctx: HandlerCtx,
  id: string,
  body: { description?: unknown; tags?: unknown; body?: unknown },
): Promise<ApiResponse> {
  const found = await findSkillFile(ctx.env.homeDir, id);
  if (!found) return { status: 404, body: { error: `unknown skill: ${id}`, isError: true } };
  const description = requiredString(body.description, "description");
  const tags = optionalStringArray(body.tags, "tags") ?? [];
  const nextBody = typeof body.body === "string" ? stripBundledResources(body.body) : "";
  const contents = buildSkillMd({
    name: found.parsed.name,
    description,
    tags,
    stacks: found.parsed.stacks,
    body: nextBody,
  });
  await writeFile(found.filePath, contents, "utf8");
  return ok({ updated: id });
}

/** Serialize a skill back to `SKILL.md` text: inline-scalar frontmatter + body. */
function buildSkillMd(input: {
  name: string;
  description: string;
  tags: string[];
  stacks?: string[];
  body: string;
}): string {
  const yamlList = (items: string[]) => `[${items.map((t) => JSON.stringify(t)).join(", ")}]`;
  const stacks = input.stacks ?? [];
  return [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    ...(input.tags.length > 0 ? [`tags: ${yamlList(input.tags)}`] : []),
    ...(stacks.length > 0 ? [`stacks: ${yamlList(stacks)}`] : []),
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

/**
 * Drop the trailing "Bundled resources (absolute paths)" index that loadSkills
 * appends for dispatch, so a client that submits a body still containing it
 * doesn't persist (and then re-append) that machine-generated block.
 */
function stripBundledResources(body: string): string {
  const idx = body.indexOf("## Bundled resources (absolute paths)");
  if (idx === -1) return body;
  return body
    .slice(0, idx)
    .replace(/\n+-{3,}\s*$/, "")
    .trimEnd();
}

export async function openFile(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const path = requiredString(body.path, "path");
  const hosts = await getAgentHostsState(ctx);
  const allowed = new Set<string>();
  for (const host of hosts.hosts) {
    for (const scope of host.scopes) {
      if (scope.available) allowed.add(scope.path);
    }
  }
  if (!allowed.has(path)) throw new Error("path is not a detected agent config");
  openPath(path);
  return ok({ log: [`opened ${path}`] });
}

export async function addServer(
  ctx: HandlerCtx,
  body: { scope?: unknown; name?: unknown; entry?: unknown },
): Promise<ApiResponse> {
  const scope = assertRatelScope(body.scope);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("name is required");
  const entry = (body.entry as ServerEntry) ?? {};
  const result = await addServerEntry(ctx, { scope, name, entry });
  return ok({ name, scope, path: result.path });
}

export async function editServer(
  ctx: HandlerCtx,
  name: string,
  body: { scope?: unknown; entry?: unknown },
): Promise<ApiResponse> {
  const scope = assertRatelScope(body.scope);
  const entry = body.entry as ServerEntry;
  const result = await editServerEntry(ctx, { scope, name, entry });
  return ok({ name, scope, path: result.path });
}

export async function removeServer(
  ctx: HandlerCtx,
  name: string,
  body: { scope?: unknown },
): Promise<ApiResponse> {
  const scope = assertRatelScope(body.scope);
  const result = await removeServerEntry(ctx, { scope, name });
  return ok({ name, scope, path: result.path });
}

export async function authServer(ctx: HandlerCtx, name: string): Promise<ApiResponse> {
  if (!name) throw new Error("name is required");
  const { result, log } = await withCapture(ctx, (c) => authorizeServer(c, name));
  const resultLines = formatAuthResults(result);
  log.push(...resultLines);
  const failedLines = resultLines.filter((_, index) => result[index]?.status === "failed");
  if (failedLines.length > 0) {
    throw new Error(failedLines.join("\n"));
  }
  return ok({ log });
}

function resolveRatelBin(): string | undefined {
  if (process.env.RATEL_MCP_BIN) return process.env.RATEL_MCP_BIN;
  if (process.argv[1]) return process.argv[1];
  return undefined;
}

export async function doImport(ctx: HandlerCtx): Promise<ApiResponse> {
  const { log } = await withCapture(ctx, (c) =>
    importAgentServers(c, { envVar: resolveRatelBin() }).then(() => undefined),
  );
  return ok({ log });
}

export async function doLink(ctx: HandlerCtx): Promise<ApiResponse> {
  const { log } = await withCapture(ctx, (c) =>
    linkAgentToRatel(c, { envVar: resolveRatelBin() }).then(() => undefined),
  );
  return ok({ log });
}

export async function previewImport(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  return ok(
    await previewAgentImport(ctx, normalizeImportBody(body), { envVar: resolveRatelBin() }),
  );
}

export async function previewLink(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  return ok(await previewAgentLink(ctx, normalizeLinkBody(body), { envVar: resolveRatelBin() }));
}

export async function applyImportRatel(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const { result, log } = await withCapture(ctx, (c) =>
    applyAgentImportRatel(c, normalizeApplyImportBody(body), { envVar: resolveRatelBin() }),
  );
  if (!result) log.push("nothing to apply");
  return ok({ log });
}

export async function applyImportAgent(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const { result, log } = await withCapture(ctx, (c) =>
    applyAgentImportAgent(c, normalizeApplyImportBody(body), { envVar: resolveRatelBin() }),
  );
  if (!result) log.push("nothing to apply");
  return ok({ log });
}

export async function applyLink(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const { result, log } = await withCapture(ctx, (c) =>
    applyAgentLink(c, normalizeApplyLinkBody(body), { envVar: resolveRatelBin() }),
  );
  if (!result) log.push("nothing to apply");
  return ok({ log });
}

function formatAuthResults(results: AuthFlowResult[]): string[] {
  if (results.length === 0) return ["[ratel] no upstreams to authorize"];
  return results.map((r) => {
    const annotation =
      r.status === "authorized" && r.mode
        ? ` (${r.mode === "refresh" ? "refreshed" : "re-authed"})`
        : "";
    const tail = r.reason ? `: ${r.reason}` : "";
    return `${r.name.padEnd(20)} ${r.status}${annotation}${tail}`;
  });
}

function normalizeImportBody(body: Record<string, unknown>) {
  return {
    hostKind: requiredHostKind(body.hostKind),
    selection: optionalStringArray(body.selection, "selection"),
    conflictStrategy: optionalConflictStrategy(body.conflictStrategy),
    replaceConflicts: optionalStringArray(body.replaceConflicts, "replaceConflicts"),
  };
}

function normalizeApplyImportBody(body: Record<string, unknown>) {
  return {
    ...normalizeImportBody(body),
    planHash: requiredString(body.planHash, "planHash"),
  };
}

function normalizeLinkBody(body: Record<string, unknown>) {
  return {
    hostKind: requiredHostKind(body.hostKind),
  };
}

function normalizeApplyLinkBody(body: Record<string, unknown>) {
  return {
    ...normalizeLinkBody(body),
    planHash: requiredString(body.planHash, "planHash"),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`${name} is required`);
}

function requiredHostKind(value: unknown): SupportedAgentHostKind {
  if (value === "claude-code" || value === "codex") return value;
  throw new Error("hostKind must be claude-code|codex");
}

function openPath(path: string): void {
  const { command, args, options } = openCommand(path);
  const child = spawn(command, args, options);
  child.unref();
}

function openCommand(path: string): { command: string; args: string[]; options: SpawnOptions } {
  const options: SpawnOptions = { detached: true, stdio: "ignore" };
  if (process.platform === "darwin") return { command: "open", args: [path], options };
  if (process.platform === "win32")
    return { command: "cmd", args: ["/c", "start", "", path], options };
  return { command: "xdg-open", args: [path], options };
}

function optionalConflictStrategy(value: unknown): ImportConflictStrategy | undefined {
  if (value === undefined) return undefined;
  if (
    value === "add-missing-only" ||
    value === "replace-from-agent" ||
    value === "replace-selected"
  ) {
    return value;
  }
  throw new Error("conflictStrategy must be add-missing-only|replace-from-agent|replace-selected");
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}
