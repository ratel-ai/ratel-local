import { type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  installClaudeCodeStatusline,
  isDirectoryEntry,
  linkAgentToRatel,
  loadSkills,
  parseSkillMd,
  previewAgentImport,
  previewAgentLink,
  type ResolvedBin,
  removeServerEntry,
  type ServerEntry,
  type SupportedAgentHostKind,
  uninstallClaudeCodeStatusline,
} from "@ratel-ai/ratel-local-core";
import type { HandlerCtx } from "../cli/handlers/types.js";
import {
  activateSkills,
  deactivateSkills,
  defaultSkillManagePaths,
  listManaged,
  type SkillSource,
} from "../cli/skills/manage.js";

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

/** Where a skill sits: an unmanaged skill's agent, or "ratel" for managed ones. */
type SkillOrigin = SkillSource | "ratel";

/**
 * The skills Ratel serves (under the managed folder `~/.ratel/skills`) plus the
 * unmanaged skills available to manage, from Claude Code (`~/.claude/skills`)
 * and Codex (`~/.codex/skills`). Each carries a `source`: managed skills report
 * the agent they came from (or "ratel" when created here); available skills
 * report the agent whose folder they live in. Loaded as the gateway loads them.
 */
export async function getSkills(ctx: HandlerCtx): Promise<ApiResponse> {
  const paths = defaultSkillManagePaths(ctx.env.homeDir);
  const { managedDir, nativeDir, codexDir } = paths;
  const problems: Array<{ id: string; where: "managed" | "available"; reason: string }> = [];

  const managed = await loadSkills([managedDir], {
    logger: ctx.log,
    onProblem: (p) => problems.push({ ...p, where: "managed" }),
  });
  const managedIds = new Set(managed.map((s) => s.id));

  const claude = await loadSkills([nativeDir], {
    logger: ctx.log,
    onProblem: (p) => problems.push({ ...p, where: "available" }),
  });
  const codex = await loadSkills([codexDir], {
    logger: ctx.log,
    onProblem: (p) => problems.push({ ...p, where: "available" }),
  });

  // Managed skills carry their origin agent; one created directly in Ratel has
  // no manifest entry → "ratel".
  const manifestEntries = await listManaged(paths);
  const originById = new Map(
    manifestEntries.map((m) => [m.id, (m.source ?? "claude") as SkillOrigin]),
  );
  const modeById = new Map(manifestEntries.map((m) => [m.id, m.mode ?? "moved"]));

  // Available = every unmanaged skill from each agent. A name that lives in both
  // Claude and Codex appears once per agent (each independently manageable, told
  // apart by `source`); a name already managed is excluded (it lives in Ratel).
  const available: Array<ReturnType<typeof skillSummary> & { source: SkillSource }> = [];
  for (const [skills, source] of [
    [claude, "claude"],
    [codex, "codex"],
  ] as const) {
    for (const s of skills) {
      if (managedIds.has(s.id)) continue;
      available.push({ ...skillSummary(s), source });
    }
  }

  return ok({
    managedDir,
    nativeDir,
    codexDir,
    managed: managed.map((s) => ({
      ...skillSummary(s),
      source: originById.get(s.id) ?? "ratel",
      mode: modeById.get(s.id) ?? "ratel",
    })),
    available,
    problems,
  });
}

function skillSummary(s: { id: string; name: string; description: string; tags?: string[] }) {
  return { id: s.id, name: s.name, description: s.description, tags: s.tags ?? [] };
}

interface FoundSkill {
  /** Absolute path to the skill's `SKILL.md`. */
  filePath: string;
  /** Which folder it was found in: the Ratel-managed one, or an agent's. */
  kind: "managed" | "claude" | "codex";
  parsed: ReturnType<typeof parseSkillMd>;
  /** The raw, unmodified `SKILL.md` text — the basis for in-place rewrites. */
  raw: string;
}

/** Expand a leading `~` to the home dir, matching how loadSkills resolves dirs. */
function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Locate the `SKILL.md` backing a skill `id` (its frontmatter `name`). Managed
 * (active) skills take precedence over native (available) ones, mirroring how
 * the gateway resolves duplicates. Within a directory the *last* match wins —
 * the same tie-break loadSkills uses (`byId.set`) — so list and detail views
 * agree on which file a duplicate name resolves to. Fail-soft per skill: a
 * malformed `SKILL.md` is skipped rather than aborting the scan. Returns null
 * when nothing matches.
 */
async function findSkillFile(homeDir: string, id: string): Promise<FoundSkill | null> {
  const { managedDir, nativeDir, codexDir } = defaultSkillManagePaths(homeDir);
  const sources: Array<{ dir: string; kind: FoundSkill["kind"] }> = [
    { dir: expandHome(managedDir, homeDir), kind: "managed" },
    { dir: expandHome(nativeDir, homeDir), kind: "claude" },
    { dir: expandHome(codexDir, homeDir), kind: "codex" },
  ];
  for (const { dir, kind } of sources) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let match: FoundSkill | null = null;
    for (const entry of entries) {
      if (!(await isDirectoryEntry(dir, entry))) continue;
      const filePath = join(dir, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = parseSkillMd(raw, filePath);
        if (parsed.name === id) match = { filePath, kind, parsed, raw };
      } catch {
        // Malformed frontmatter — skip, matching loadSkills' fail-soft behaviour.
      }
    }
    if (match) return match;
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
  const { parsed, kind } = found;
  // Managed skills report their origin agent (from the manifest), or "ratel"
  // when created here; unmanaged ones report the agent folder they live in.
  let source: SkillOrigin;
  if (kind === "managed") {
    const entry = (await listManaged(defaultSkillManagePaths(ctx.env.homeDir))).find(
      (m) => m.id === id,
    );
    source = entry?.source ?? "ratel";
  } else {
    source = kind;
  }
  return ok({
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    // Mirror the list view: triggers and tags are both indexed phrases.
    tags: [...parsed.tags, ...parsed.triggers],
    body: parsed.body,
    state: kind === "managed" ? "active" : "available",
    source,
  });
}

/** Manage skills through Ratel as invoke-only. `ids` omitted = activate all;
 *  `source` ("claude"|"codex") disambiguates a name present in both agents. */
export async function activateSkillsRoute(
  ctx: HandlerCtx,
  body: { ids?: unknown; source?: unknown },
): Promise<ApiResponse> {
  const ids = optionalStringArray(body.ids, "ids");
  const source = body.source === "claude" || body.source === "codex" ? body.source : undefined;
  const result = await activateSkills(defaultSkillManagePaths(ctx.env.homeDir), {
    ids,
    source,
    logger: ctx.log,
  });
  const responseBody = {
    managed: result.managed.map((m) => ({ id: m.id, mode: m.mode ?? "moved" })),
    skipped: result.skipped,
  };
  return ok(responseBody);
}

/** Stop managing skills through Ratel. `ids` omitted = all. */
export async function deactivateSkillsRoute(
  ctx: HandlerCtx,
  body: { ids?: unknown },
): Promise<ApiResponse> {
  const ids = optionalStringArray(body.ids, "ids");
  const result = await deactivateSkills(defaultSkillManagePaths(ctx.env.homeDir), {
    ids,
    logger: ctx.log,
  });
  return ok({ unmanaged: result.unmanaged.map((m) => m.id), skipped: result.skipped });
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
 * Overwrite an existing *active* skill's `SKILL.md` in place. The skill's `name`
 * and location are fixed (renaming would move the directory and break the
 * manifest) — only description, tags, and body change. The rewrite is
 * surgical: every other frontmatter key (`stacks`, Claude Code's `allowed-tools`
 * / `model` / `license`, comments, custom keys) is preserved byte-for-byte;
 * only `description`/`tags` are re-emitted and `triggers` folds into `tags`,
 * since both are indexed phrases.
 *
 * Unmanaged skills (in an agent's own folder, Claude or Codex) are read-only
 * here: editing the file an agent owns before it's brought into Ratel is
 * surprising and can clash with that agent's own management, so callers must
 * manage it with Ratel first.
 */
export async function updateSkillRoute(
  ctx: HandlerCtx,
  id: string,
  body: { description?: unknown; tags?: unknown; body?: unknown },
): Promise<ApiResponse> {
  const found = await findSkillFile(ctx.env.homeDir, id);
  if (!found) return { status: 404, body: { error: `unknown skill: ${id}`, isError: true } };
  if (found.kind !== "managed") {
    return {
      status: 409,
      body: { error: "manage the skill with Ratel before editing it", isError: true },
    };
  }
  const description = requiredString(body.description, "description");
  const tags = optionalStringArray(body.tags, "tags") ?? [];
  // Distinguish "omitted" (a malformed request) from an intentionally empty
  // body — the former is an error, the latter clears the instructions.
  if (typeof body.body !== "string") throw new Error("body is required");
  const nextBody = stripBundledResources(body.body);
  const contents = rewriteSkillMd(found.raw, { description, tags, body: nextBody });
  await writeFileAtomic(found.filePath, contents);
  return ok({ updated: id });
}

/**
 * Rewrite a `SKILL.md` while preserving its frontmatter: only `description` and
 * `tags` are replaced (in place, at their original position), `triggers` is
 * dropped (its phrases arrive merged into `tags`), and every other key/comment
 * is kept verbatim. Falls back to a fresh serialization if the source somehow
 * has no frontmatter (unreachable for a skill that was found via parseSkillMd).
 */
function rewriteSkillMd(
  raw: string,
  next: { description: string; tags: string[]; body: string },
): string {
  const lines = raw.split(/\r?\n/);
  let open = 0;
  while (open < lines.length && lines[open].trim() === "") open++;
  let close = -1;
  for (let j = open + 1; j < lines.length; j++) {
    if (lines[j].trim() === "---") {
      close = j;
      break;
    }
  }
  const descLine = `description: ${JSON.stringify(next.description)}`;
  const tagsLine =
    next.tags.length > 0 ? `tags: [${next.tags.map((t) => JSON.stringify(t)).join(", ")}]` : null;

  if (lines[open]?.trim() !== "---" || close === -1) {
    return ["---", descLine, ...(tagsLine ? [tagsLine] : []), "---", "", next.body.trim(), ""].join(
      "\n",
    );
  }

  const out: string[] = [];
  let descWritten = false;
  let tagsWritten = false;
  for (let j = open + 1; j < close; j++) {
    const line = lines[j];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const sep = line.indexOf(":");
    const key = sep === -1 ? "" : line.slice(0, sep).trim();
    const isBlockKey = sep !== -1 && line.slice(sep + 1).trim() === "";
    // A managed key written in YAML block style spreads over indented `- item`
    // lines; consume them too so we replace the whole field, not just its head.
    const skipBlockList = () => {
      while (j + 1 < close && /^\s*-\s+/.test(lines[j + 1])) j++;
    };
    if (key === "description") {
      if (!descWritten) {
        out.push(descLine);
        descWritten = true;
      }
      if (isBlockKey) skipBlockList();
      continue;
    }
    if (key === "tags" || key === "triggers") {
      // Collapse tags + triggers into a single tags line at the first of them.
      if (!tagsWritten) {
        if (tagsLine) out.push(tagsLine);
        tagsWritten = true;
      }
      if (isBlockKey) skipBlockList();
      continue;
    }
    out.push(line);
  }
  if (!descWritten) out.push(descLine);
  if (!tagsWritten && tagsLine) out.push(tagsLine);

  const frontmatter = out.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return ["---", frontmatter, "---", "", next.body.trim(), ""].join("\n");
}

/** Write a file atomically: a crash mid-write never leaves a truncated file. */
async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.ratel-tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
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
 *
 * Anchored to the exact block loadSkills emits (`\n\n---\n\n## Bundled
 * resources (absolute paths)\n…` to end-of-string) so an author who legitimately
 * writes that heading mid-body isn't silently truncated.
 */
const BUNDLED_RESOURCES_BLOCK = /\n\n---\n\n## Bundled resources \(absolute paths\)\n[\s\S]*$/;

function stripBundledResources(body: string): string {
  return body.replace(BUNDLED_RESOURCES_BLOCK, "").trimEnd();
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
  const failedLines = resultLines.filter((_, index) => {
    const status = result[index]?.status;
    return status === "failed" || status === "unsupported";
  });
  if (failedLines.length > 0) {
    throw new Error(failedLines.join("\n"));
  }
  return ok({ log });
}

function resolveRatelBin(): string | undefined {
  if (process.env.RATEL_LOCAL_BIN) return process.env.RATEL_LOCAL_BIN;
  if (process.argv[1]) return process.argv[1];
  return undefined;
}

function resolveUiRatelBin(): ResolvedBin {
  const command = resolveRatelBin();
  if (!command) throw new Error("Could not locate the ratel-local binary for statusline install");
  return { command, args: [], source: "env" };
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

export async function installClaudeStatuslineRoute(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const { result, log } = await withCapture(ctx, (c) =>
    installClaudeCodeStatusline(c, {
      bin: resolveUiRatelBin(),
      force: body.force === true,
    }),
  );
  log.push(
    result.changed
      ? `installed Ratel statusline into ${result.path}`
      : "Ratel statusline already installed",
  );
  return ok({ log, state: result.state });
}

export async function uninstallClaudeStatuslineRoute(ctx: HandlerCtx): Promise<ApiResponse> {
  const { result, log } = await withCapture(ctx, (c) => uninstallClaudeCodeStatusline(c));
  log.push(
    result.changed
      ? `removed Ratel statusline from ${result.path}`
      : "no Ratel statusline to remove",
  );
  return ok({ log, state: result.state });
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
