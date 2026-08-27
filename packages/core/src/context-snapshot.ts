import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Skill } from "@ratel-ai/sdk";
import type {
  DocumentRevision,
  ProjectId,
  RatelScopeRef,
  RuntimeContextRef,
  RuntimeRevision,
} from "./context.js";
import { ratelConfigPath } from "./hierarchy.js";
import { isPlainObject } from "./json.js";
import {
  mergeConfigs,
  parseConfig,
  type RatelConfig,
  type RatelConfigDocument,
  type RetrievalConfig,
} from "./lib/config.js";
import {
  type ResolvedSkillCatalog,
  resolveConfiguredSkills,
  type SkillScopeConfig,
} from "./lib/skills/resolve.js";
import { documentRevision } from "./mutation-engine.js";
import { assertSafeProjectControlPath, ProjectPathSafetyError } from "./project-path-safety.js";
import type { ProjectRegistry } from "./project-registry.js";
import { type ResolvedMcpEntry, resolveMcpEntries } from "./resolved-mcp.js";

export const CONTEXT_SNAPSHOT_RESOLVER_VERSION = 4;

export interface Diagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  path?: string;
}

export interface WatchInput {
  path: string;
  kind: "file" | "directory";
}

export interface ScopedDocumentSnapshot {
  ref: RatelScopeRef;
  path: string;
  documentRevision: DocumentRevision;
  document: RatelConfigDocument;
  config: RatelConfig;
}

export interface ResolvedContextSnapshot {
  context: RuntimeContextRef;
  projectRoot?: string;
  documents: ScopedDocumentSnapshot[];
  runtimeRevision: RuntimeRevision;
  mcpEntries: ResolvedMcpEntry[];
  skills: ResolvedSkillCatalog;
  /** Atomic right-most retrieval block for this resolved context. */
  retrieval?: RetrievalConfig;
  diagnostics: Diagnostic[];
  watchInputs: WatchInput[];
}

export interface ContextSnapshotResolver {
  resolve(context: RuntimeContextRef): Promise<ResolvedContextSnapshot>;
}

export interface ContextSnapshotResolverOptions {
  homeDir: string;
  projectRegistry: ProjectRegistry;
  maxReadAttempts?: number;
  /** Daemon environment used to resolve MCP URL placeholders. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected catalog pull; this module does no network I/O. */
  cloudCatalog?: (
    context: RuntimeContextRef,
    profile?: string,
  ) => Promise<CloudSkillCatalog | undefined>;
}

/** One catalog pull: what it returned, or why it did not. */
interface CloudCatalogPull {
  catalog?: CloudSkillCatalog;
  error?: string;
}

export interface CloudSkillCatalog {
  catalogVersion: string;
  skills: Skill[];
}

export class InvalidContextSnapshotError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "InvalidContextSnapshotError";
  }
}

export class ProjectUnavailableError extends Error {
  readonly statusCode = 409;
  readonly code = "PROJECT_UNAVAILABLE";

  constructor(
    readonly projectId: ProjectId,
    readonly projectRoot: string,
  ) {
    super(`project ${projectId} is missing: ${projectRoot}`);
    this.name = "ProjectUnavailableError";
  }
}

interface DocumentTarget {
  ref: RatelScopeRef;
  path: string;
}

interface ReadResult {
  target: DocumentTarget;
  snapshot?: ScopedDocumentSnapshot;
  revision?: DocumentRevision;
}

interface OAuthStoreRevision {
  path: string;
  revision: string;
}

export function createContextSnapshotResolver(
  options: ContextSnapshotResolverOptions,
): ContextSnapshotResolver {
  const maxReadAttempts = options.maxReadAttempts ?? 3;
  return {
    async resolve(context) {
      // Memoized outside the retry loop so a catalog change cannot spin it. The
      // promise never rejects: an unresolvable profile or an unreachable Cloud
      // is reported as a diagnostic, not as a failed context resolution.
      let pulled: { profile?: string; catalog: Promise<CloudCatalogPull> } | undefined;
      const pullCloudCatalog = (profile?: string) => {
        if (!pulled || pulled.profile !== profile) {
          pulled = {
            profile,
            catalog: (options.cloudCatalog?.(context, profile) ?? Promise.resolve(undefined)).then(
              (catalog) => ({ catalog }),
              (error: Error) => ({ error: error.message }),
            ),
          };
        }
        return pulled.catalog;
      };
      const projectRoot = await resolveProjectRoot(context, options.projectRegistry);
      const targets = documentTargets(options.homeDir, context, projectRoot);
      if (projectRoot) {
        try {
          await Promise.all(
            targets
              .filter(({ ref }) => ref.scope !== "user")
              .map(({ path }) => assertSafeProjectControlPath(projectRoot, path)),
          );
        } catch (error) {
          if (error instanceof ProjectPathSafetyError) {
            throw new InvalidContextSnapshotError([
              {
                code: "project-control-path-unsafe",
                severity: "error",
                message: error.message,
                path: error.path,
              },
            ]);
          }
          throw error;
        }
      }

      for (let attempt = 0; attempt < maxReadAttempts; attempt++) {
        const reads = await Promise.all(targets.map(readDocument));
        const documents = reads.flatMap((read) => (read.snapshot ? [read.snapshot] : []));
        const scopes: SkillScopeConfig[] = targets.map((target) => ({
          ref: target.ref,
          config: documents.find((document) => sameScope(document.ref, target.ref))?.config.skills,
        }));

        const firstSkills = await resolveConfiguredSkills({
          homeDir: options.homeDir,
          ...(projectRoot ? { projectRoot } : {}),
          scopes,
        });
        const afterReads = await Promise.all(targets.map(readDocument));
        if (!sameReadSet(reads, afterReads)) continue;

        const skills = await resolveConfiguredSkills({
          homeDir: options.homeDir,
          ...(projectRoot ? { projectRoot } : {}),
          scopes,
        });
        if (skills.fingerprint !== firstSkills.fingerprint) continue;

        const mcpEntries = resolveMcpEntries({
          homeDir: options.homeDir,
          ...(projectRoot ? { projectRoot } : {}),
          documents: documents.map(({ ref, config }) => ({ ref, config })),
          ...(options.env ? { env: options.env } : {}),
        });
        const oauthStoreRevisions = await readOAuthStoreRevisions(mcpEntries);
        const confirmedOAuthStoreRevisions = await readOAuthStoreRevisions(mcpEntries);
        if (!sameOAuthStoreRevisions(oauthStoreRevisions, confirmedOAuthStoreRevisions)) continue;
        const merged = mergeConfigs(documents.map(({ config }) => config));
        const retrieval = merged.retrieval;
        const cloud = await pullCloudCatalog(merged.cloud?.profile);
        const composed = composeSkills(skills.effectiveSkills, cloud.catalog?.skills ?? []);
        const diagnostics: Diagnostic[] = [
          ...(cloud.error
            ? [
                {
                  code: "cloud-catalog-unavailable",
                  severity: "warning" as const,
                  message: `Cloud skills are not in use: ${cloud.error}`,
                },
              ]
            : []),
          ...composed.shadowed.map((id) => ({
            code: "cloud-skill-shadowed",
            severity: "warning" as const,
            message: `Cloud skill "${id}" is not in use: a local skill with the same id takes precedence. Remove or rename the local skill to use the published one.`,
          })),
          ...skills.diagnostics.map(({ code, severity, message, path }) => ({
            code,
            severity,
            message,
            ...(path ? { path } : {}),
          })),
          ...mcpEntries.flatMap((entry) =>
            entry.diagnostics.map(({ code, message }) => ({
              code,
              severity: "error" as const,
              message,
            })),
          ),
        ];
        const runtimeRevision = digestRuntimeRevision(
          documents,
          mcpEntries,
          skills.fingerprint,
          oauthStoreRevisions,
          cloud.catalog?.catalogVersion,
        );
        const skillWatchInputs = await Promise.all(
          skills.watchInputs.map(async (path): Promise<WatchInput> => {
            try {
              return { path, kind: (await stat(path)).isDirectory() ? "directory" : "file" };
            } catch {
              // Configured paths that do not exist yet are directories. Existing
              // skill files are also covered by their containing skill directory.
              return {
                path,
                kind: path === dirname(path) ? "file" : "directory",
              };
            }
          }),
        );
        const watchInputs = uniqueWatchInputs([
          ...targets.map(({ path }) => ({ path: dirname(path), kind: "directory" as const })),
          ...skillWatchInputs,
          ...oauthStoreRevisions.map(({ path }) => ({ path, kind: "file" as const })),
        ]);

        return {
          context,
          ...(projectRoot ? { projectRoot } : {}),
          documents,
          runtimeRevision,
          mcpEntries,
          // Cloud skills have no registration or file to watch.
          skills: { ...skills, effectiveSkills: composed.skills },
          ...(retrieval ? { retrieval } : {}),
          diagnostics,
          watchInputs,
        };
      }

      throw new InvalidContextSnapshotError([
        {
          code: "snapshot-unstable",
          severity: "error",
          message: `configuration changed while resolving after ${maxReadAttempts} attempts`,
        },
      ]);
    },
  };
}

async function resolveProjectRoot(
  context: RuntimeContextRef,
  registry: ProjectRegistry,
): Promise<string | undefined> {
  if (context.kind === "global") return undefined;
  const project = await registry.resolve(context.projectId);
  try {
    if (!(await stat(project.canonicalRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ProjectUnavailableError(project.id, project.canonicalRoot);
  }
  return project.canonicalRoot;
}

function documentTargets(
  homeDir: string,
  context: RuntimeContextRef,
  projectRoot: string | undefined,
): DocumentTarget[] {
  const targets: DocumentTarget[] = [
    { ref: { scope: "user" }, path: ratelConfigPath("user", { homeDir }) },
  ];
  if (context.kind === "project" && projectRoot) {
    targets.push(
      {
        ref: { scope: "project", projectId: context.projectId },
        path: ratelConfigPath("project", { homeDir, projectRoot }),
      },
      {
        ref: { scope: "local", projectId: context.projectId },
        path: ratelConfigPath("local", { homeDir, projectRoot }),
      },
    );
  }
  return targets;
}

async function readDocument(target: DocumentTarget): Promise<ReadResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(target.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { target };
    throw error;
  }
  const documentRevision = hashBytes(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw invalidDocument(target.path, `invalid JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw invalidDocument(target.path, "root must be a JSON object");
  let config: RatelConfig;
  try {
    config = parseConfig(parsed);
  } catch (error) {
    throw invalidDocument(target.path, (error as Error).message);
  }
  return {
    target,
    revision: documentRevision,
    snapshot: {
      ref: target.ref,
      path: target.path,
      documentRevision,
      document: parsed as RatelConfigDocument,
      config,
    },
  };
}

function invalidDocument(path: string, reason: string): InvalidContextSnapshotError {
  return new InvalidContextSnapshotError([
    { code: "config-invalid", severity: "error", message: `${path}: ${reason}`, path },
  ]);
}

function sameReadSet(before: ReadResult[], after: ReadResult[]): boolean {
  return before.every((read, index) => read.revision === after[index]?.revision);
}

async function readOAuthStoreRevisions(
  entries: readonly ResolvedMcpEntry[],
): Promise<OAuthStoreRevision[]> {
  const targets = Array.from(
    new Map(
      entries
        .filter(
          ({ entry, status }) =>
            status === "effective" && (entry.type === "http" || entry.type === "sse"),
        )
        .map(({ oauthKey }) => [oauthKey.path, oauthKey.fingerprint] as const),
    ),
  ).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Promise.all(
    targets.map(async ([path, expectedFingerprint]) => {
      try {
        const parsed = JSON.parse((await readFile(path)).toString("utf8")) as unknown;
        const state = isPlainObject(parsed) ? parsed : {};
        return {
          path,
          revision: oauthActivationRevision(state, expectedFingerprint),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { path, revision: oauthActivationRevision({}, expectedFingerprint) };
        }
        throw error;
      }
    }),
  );
}

function oauthActivationRevision(
  state: Record<string, unknown>,
  expectedFingerprint: string,
): string {
  const storedFingerprint =
    typeof state.resource_fingerprint === "string" ? state.resource_fingerprint : undefined;
  return createHash("sha256")
    .update(
      stableStringify({
        fingerprintMismatch:
          storedFingerprint !== undefined && storedFingerprint !== expectedFingerprint,
        tokens: state.tokens ?? null,
      }),
    )
    .digest("base64url");
}

function sameOAuthStoreRevisions(
  before: readonly OAuthStoreRevision[],
  after: readonly OAuthStoreRevision[],
): boolean {
  return (
    before.length === after.length &&
    before.every(
      (revision, index) =>
        revision.path === after[index]?.path && revision.revision === after[index]?.revision,
    )
  );
}

function sameScope(a: RatelScopeRef, b: RatelScopeRef): boolean {
  return (
    a.scope === b.scope &&
    (a.scope === "user" || (b.scope !== "user" && a.projectId === b.projectId))
  );
}

/** Local id wins; shadowed Cloud ids are returned, not dropped. */
function composeSkills(local: Skill[], cloud: Skill[]) {
  const localIds = new Set(local.map(({ id }) => id));
  return {
    skills: [...local, ...cloud.filter(({ id }) => !localIds.has(id))],
    shadowed: cloud.filter(({ id }) => localIds.has(id)).map(({ id }) => id),
  };
}

function digestRuntimeRevision(
  documents: ScopedDocumentSnapshot[],
  mcpEntries: ResolvedMcpEntry[],
  skillFingerprint: string,
  oauthStoreRevisions: readonly OAuthStoreRevision[],
  cloudCatalogVersion: string | undefined,
): RuntimeRevision {
  const normalizedDocuments = documents.map(({ ref, config }) => ({ ref, config }));
  const runtimeMcpEntries = mcpEntries.map(({ name, owner, status, runtimeCwd, oauthKey }) => ({
    name,
    owner,
    status,
    runtimeCwd,
    oauthFingerprint: oauthKey.fingerprint,
  }));
  return (
    createHash("sha256")
      .update(`ratel-runtime-v${CONTEXT_SNAPSHOT_RESOLVER_VERSION}\0`)
      .update(stableStringify(normalizedDocuments))
      .update("\0")
      .update(stableStringify(runtimeMcpEntries))
      .update("\0")
      .update(skillFingerprint)
      .update("\0")
      .update(stableStringify(oauthStoreRevisions))
      .update("\0")
      // Cloud skills have no path, so the fingerprint above cannot see them.
      .update(cloudCatalogVersion ?? "")
      .digest("base64url") as RuntimeRevision
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashBytes(bytes: Buffer): DocumentRevision {
  return documentRevision(bytes);
}

function uniqueWatchInputs(inputs: WatchInput[]): WatchInput[] {
  const seen = new Set<string>();
  return inputs.filter((input) => {
    const key = `${input.kind}\0${input.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
