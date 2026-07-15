import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseSkillMd } from "./lib/skills/load.js";
import { isSafeSkillId } from "./skill-id.js";

export type DiscoveredSkillSource = "claude" | "codex-current" | "codex-legacy" | "ratel";

export type SkillDiscoveryContext = { kind: "global" } | { kind: "project"; projectRoot: string };

export interface SkillCandidate {
  candidateId: string;
  id: string;
  name: string;
  description: string;
  source: DiscoveredSkillSource;
  canonicalPath: string;
  context: SkillDiscoveryContext;
  digest: string;
}

export interface SkillDiscoveryDiagnostic {
  path: string;
  message: string;
}

export interface SkillDiscoveryResult {
  candidates: SkillCandidate[];
  diagnostics: SkillDiscoveryDiagnostic[];
  visitedDirectories: number;
  truncated: boolean;
  timedOut: boolean;
}

export interface SkillDiscoveryOptions {
  homeDir: string;
  maxDepth?: number;
  maxDirectories?: number;
  maxSkills?: number;
  timeoutMs?: number;
  now?: () => number;
  registeredProjectRoots?: () => Promise<string[]>;
}

export interface SkillDiscovery {
  discover(context: SkillDiscoveryContext): Promise<SkillDiscoveryResult>;
  resolveCandidate(candidateId: string): Promise<SkillCandidate>;
}

interface CachedCandidate extends SkillCandidate {
  contextKey: string;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  "coverage",
  "target",
  ".cache",
  "__pycache__",
]);

export class UnknownSkillCandidateError extends Error {
  constructor(readonly candidateId: string) {
    super(`unknown skill candidate: ${candidateId}`);
    this.name = "UnknownSkillCandidateError";
  }
}

export class StaleSkillCandidateError extends Error {
  constructor(readonly candidateId: string) {
    super(`skill candidate is stale: ${candidateId}`);
    this.name = "StaleSkillCandidateError";
  }
}

export function createSkillDiscovery(options: SkillDiscoveryOptions): SkillDiscovery {
  return new FilesystemSkillDiscovery(options);
}

class FilesystemSkillDiscovery implements SkillDiscovery {
  private readonly cache = new Map<string, CachedCandidate>();
  private readonly now: () => number;

  constructor(private readonly options: SkillDiscoveryOptions) {
    this.now = options.now ?? Date.now;
  }

  async discover(context: SkillDiscoveryContext): Promise<SkillDiscoveryResult> {
    const result =
      context.kind === "global"
        ? await this.discoverGlobal(context)
        : await this.discoverProject(context);
    for (const candidate of result.candidates) {
      this.cache.set(candidate.candidateId, {
        ...candidate,
        contextKey: discoveryContextKey(candidate.context),
      });
    }
    return result;
  }

  async resolveCandidate(candidateId: string): Promise<SkillCandidate> {
    const cached = this.cache.get(candidateId);
    if (!cached) throw new UnknownSkillCandidateError(candidateId);
    let refreshed: SkillCandidate;
    try {
      refreshed = await candidateFromDirectory(cached.canonicalPath, cached.source, cached.context);
    } catch {
      throw new StaleSkillCandidateError(candidateId);
    }
    if (refreshed.candidateId !== candidateId || refreshed.digest !== cached.digest) {
      throw new StaleSkillCandidateError(candidateId);
    }
    return refreshed;
  }

  private async discoverGlobal(context: Extract<SkillDiscoveryContext, { kind: "global" }>) {
    const sources: Array<{ source: DiscoveredSkillSource; path: string }> = [
      { source: "claude", path: join(this.options.homeDir, ".claude", "skills") },
      { source: "codex-current", path: join(this.options.homeDir, ".agents", "skills") },
      { source: "codex-legacy", path: join(this.options.homeDir, ".codex", "skills") },
      { source: "ratel", path: join(this.options.homeDir, ".ratel", "skills") },
    ];
    const diagnostics: SkillDiscoveryDiagnostic[] = [];
    const candidates: SkillCandidate[] = [];
    let visitedDirectories = 0;
    const maxSkills = this.options.maxSkills ?? 2_000;
    for (const source of sources) {
      const entries = await readDirectory(source.path, diagnostics);
      visitedDirectories += entries === undefined ? 0 : 1;
      if (!entries) continue;
      for (const entry of entries.sort(compareDirent)) {
        if (candidates.length >= maxSkills) break;
        const path = join(source.path, entry.name);
        if (!(await isDirectoryOrDirectorySymlink(path, entry))) continue;
        await pushCandidate(candidates, diagnostics, path, source.source, context);
      }
    }
    return {
      candidates,
      diagnostics,
      visitedDirectories,
      truncated: candidates.length >= maxSkills,
      timedOut: false,
    } satisfies SkillDiscoveryResult;
  }

  private async discoverProject(
    input: Extract<SkillDiscoveryContext, { kind: "project" }>,
  ): Promise<SkillDiscoveryResult> {
    const projectRoot = await realpath(input.projectRoot);
    const context: SkillDiscoveryContext = { kind: "project", projectRoot };
    const diagnostics: SkillDiscoveryDiagnostic[] = [];
    const candidates: SkillCandidate[] = [];
    const startedAt = this.now();
    const maxDepth = this.options.maxDepth ?? 8;
    const maxDirectories = this.options.maxDirectories ?? 20_000;
    const maxSkills = this.options.maxSkills ?? 2_000;
    const timeoutMs = this.options.timeoutMs ?? 3_000;
    const nestedRoots = new Set(
      (await this.options.registeredProjectRoots?.())?.filter((root) => root !== projectRoot) ?? [],
    );
    const queue: Array<{ path: string; depth: number }> = [{ path: projectRoot, depth: 0 }];
    let visitedDirectories = 0;
    let timedOut = false;
    let truncated = false;

    while (queue.length > 0) {
      if (this.now() - startedAt > timeoutMs) {
        timedOut = true;
        break;
      }
      if (visitedDirectories >= maxDirectories || candidates.length >= maxSkills) {
        truncated = true;
        break;
      }
      const current = queue.shift() as { path: string; depth: number };
      visitedDirectories += 1;
      const entries = await readDirectory(current.path, diagnostics);
      if (!entries) continue;

      if (basename(current.path) === "skills") {
        const parent = basename(dirname(current.path));
        if (parent === ".claude" || parent === ".agents") {
          const source: DiscoveredSkillSource = parent === ".claude" ? "claude" : "codex-current";
          for (const entry of entries.sort(compareDirent)) {
            if (candidates.length >= maxSkills) {
              truncated = true;
              break;
            }
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            await pushCandidate(
              candidates,
              diagnostics,
              join(current.path, entry.name),
              source,
              context,
            );
          }
          continue;
        }
      }

      if (current.depth >= maxDepth) continue;
      for (const entry of entries.sort(compareDirent)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const child = join(current.path, entry.name);
        if (nestedRoots.has(child)) continue;
        queue.push({ path: child, depth: current.depth + 1 });
      }
    }

    candidates.sort((a, b) => compareText(a.canonicalPath, b.canonicalPath));
    return { candidates, diagnostics, visitedDirectories, truncated, timedOut };
  }
}

async function pushCandidate(
  candidates: SkillCandidate[],
  diagnostics: SkillDiscoveryDiagnostic[],
  path: string,
  source: DiscoveredSkillSource,
  context: SkillDiscoveryContext,
): Promise<void> {
  try {
    candidates.push(await candidateFromDirectory(path, source, context));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    diagnostics.push({ path, message: (error as Error).message });
  }
}

async function candidateFromDirectory(
  path: string,
  source: DiscoveredSkillSource,
  context: SkillDiscoveryContext,
): Promise<SkillCandidate> {
  const canonicalPath = await realpath(path);
  if (!(await stat(canonicalPath)).isDirectory()) throw new Error(`${path} is not a directory`);
  const id = basename(path);
  if (!isSafeSkillId(id)) throw new Error(`${path} has an unsafe skill directory name`);
  const raw = await readFile(join(canonicalPath, "SKILL.md"), "utf8");
  const parsed = parseSkillMd(raw, join(canonicalPath, "SKILL.md"), id);
  const digest = await digestSkillDirectory(canonicalPath);
  const candidateId = `cand_${createHash("sha256")
    .update("ratel-skill-candidate-v1\0")
    .update(discoveryContextKey(context))
    .update("\0")
    .update(canonicalPath)
    .update("\0")
    .update(digest)
    .digest("base64url")}`;
  return {
    candidateId,
    id,
    name: parsed.name,
    description: parsed.description,
    source,
    canonicalPath,
    context,
    digest,
  };
}

async function digestSkillDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const queue = [""];
  while (queue.length > 0) {
    const relative = queue.shift() as string;
    const directory = join(root, relative);
    const entries = (await readdir(directory, { withFileTypes: true })).sort(compareDirent);
    for (const entry of entries) {
      const childRelative = relative ? join(relative, entry.name) : entry.name;
      const child = join(root, childRelative);
      if (entry.isDirectory()) {
        hash.update(`d\0${childRelative}\0`);
        queue.push(childRelative);
      } else if (entry.isFile()) {
        hash.update(`f\0${childRelative}\0`);
        hash.update(await readFile(child));
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${childRelative}\0`);
      } else {
        hash.update(`s\0${childRelative}\0`);
      }
    }
  }
  return hash.digest("base64url");
}

async function readDirectory(
  path: string,
  diagnostics: SkillDiscoveryDiagnostic[],
): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ path, message: (error as Error).message });
    }
    return undefined;
  }
}

async function isDirectoryOrDirectorySymlink(path: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path)).isDirectory() && (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function compareDirent(a: Dirent, b: Dirent): number {
  return compareText(a.name, b.name);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function discoveryContextKey(context: SkillDiscoveryContext): string {
  return context.kind === "global" ? "global" : `project:${context.projectRoot}`;
}
