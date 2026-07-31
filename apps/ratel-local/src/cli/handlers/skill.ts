import { join } from "node:path";
import {
  type ContextSnapshotResolver,
  createConfigControlPlane,
  createContextSnapshotResolver,
  createLocalGitExcludeManager,
  createMutationEngine,
  createPreparedChangeCoordinator,
  createProjectRegistry,
  createSkillDiscovery,
  createSkillImportControlPlane,
  createSkillRegistrationControlPlane,
  type MutationCommit,
  type PreparedChange,
  type ProjectId,
  ProjectNotFoundError,
  type ProjectRegistry,
  type RuntimeContextRef,
  type SkillCandidate,
  type SkillDiscovery,
  type SkillImportCommit,
  type SkillImportControlPlane,
  type SkillImportReview,
  type SkillRegistrationCommit,
  type SkillRegistrationControlPlane,
  type SkillRegistrationReview,
} from "@ratel-ai/ratel-local-core";
import type { Skill } from "@ratel-ai/sdk";
import type { FlagValue } from "../args.js";
import { type DaemonApiRequest, requestRunningDaemon, requireDaemonJson } from "../daemon-api.js";
import { resolveCliRatelBin } from "../ratel-bin.js";
import {
  type HookScope,
  installHook,
  preloadHookCommand,
  prepareInstallHook,
  prepareUninstallHook,
  settingsPathForScope,
  uninstallHook,
} from "../skills/install-hook.js";
import {
  loadNudged,
  parseHookInput,
  preloadStateDir,
  recordNudged,
  runPreloadHook,
} from "../skills/preload.js";
import { defaultSignalCacheFile, detectProjectSignalsCached } from "../skills/signals.js";
import { suggestSkills } from "../skills/suggest.js";
import { readStdin } from "../stdin.js";
import type { HandlerCtx } from "./types.js";

export const SKILL_USAGE = `usage: ratel-local skill <verb>

Verbs:
  import           import discovered skills into a scoped registration
  add-scope        add another scoped registration for a skill
  remove-scope     remove only the selected registration
  remove           remove a registration and its owned copy when applicable
  list             list effective/configured/discovered skills [--project <id-or-path>]
  suggest          rank skills for a prompt (--prompt, --cwd, --dir, --limit, --min-score)
  preload-hook     UserPromptSubmit hook entrypoint (reads JSON on stdin; injects a nudge)
  install-hook     register the preload hook in settings.json (--scope user|project)
  uninstall-hook   remove the preload hook from settings.json (--scope user|project)

Flags:
  --scope          target user|project|local (default: user)
  --mode           use reference|copy for import/add-scope (default: reference)
  --effective      list the effective catalog (default)
  --configured     list registrations including shadowed/invalid entries
  --discovered     inventory native candidate skills
  --project        select a registered project id or canonicalizable path
  --dry-run        report what would be managed without touching any files
  --yes            skip the confirmation prompt`;

export interface SkillHandlerOptions {
  registry?: ProjectRegistry;
  resolver?: ContextSnapshotResolver;
  discovery?: SkillDiscovery;
  importControlPlane?: SkillImportControlPlane;
  registrationControlPlane?: SkillRegistrationControlPlane;
  daemonRequest?: DaemonApiRequest;
}

export async function runSkill(ctx: HandlerCtx, options: SkillHandlerOptions = {}): Promise<void> {
  const verb = ctx.argv.verb;
  const dryRun = ctx.argv.flags["dry-run"] === true;
  const assumeYes = ctx.argv.flags.yes === true;

  switch (verb) {
    case "import": {
      const runtime = createSkillReadRuntime(ctx, options);
      const context = await resolveSkillContext(
        ctx.argv.flags.project,
        ctx.env.projectRoot,
        runtime.registry,
      );
      const target = mutationTarget(ctx.argv.flags.scope, context);
      const mode = importMode(ctx.argv.flags.mode);
      const project =
        context.kind === "project" ? await runtime.registry.resolve(context.projectId) : undefined;
      const daemonRequest =
        options.daemonRequest ?? ((path, init) => requestRunningDaemon(ctx, path, init));
      const remoteDiscovery = await daemonRequest(contextApiPath("/api/skills", context));
      let candidates: SkillCandidate[];
      if (remoteDiscovery) {
        const body = await requireDaemonJson<{ discovered?: SkillCandidate[] }>(
          remoteDiscovery,
          "skill discovery",
        );
        if (!Array.isArray(body.discovered)) {
          throw new Error("daemon skill discovery returned an invalid candidate inventory");
        }
        candidates = body.discovered;
      } else {
        candidates = (
          await runtime.discovery.discover(
            project ? { kind: "project", projectRoot: project.canonicalRoot } : { kind: "global" },
          )
        ).candidates;
      }
      const selectedCandidates = await selectImportCandidates(ctx, candidates, ctx.argv.rest);
      if (selectedCandidates.length === 0) {
        ctx.log("no skills selected");
        return;
      }
      const selections = selectedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: target, mode }],
      }));
      const remotePreview = await daemonRequest(
        contextApiPath("/api/skills/import/prepare", context),
        {
          method: "POST",
          body: { selections },
        },
      );
      let control: SkillImportControlPlane | undefined;
      let change: PreparedChange<SkillImportReview>;
      if (remotePreview) {
        change = await requireDaemonJson<PreparedChange<SkillImportReview>>(
          remotePreview,
          "skill import preparation",
        );
      } else {
        if (remoteDiscovery) {
          throw new Error(
            "skill discovery came from the daemon, but the daemon disappeared before preview",
          );
        }
        control = options.importControlPlane ?? (await createImportControlPlane(ctx, runtime));
        change = await control.prepare(selections);
      }
      if (dryRun) {
        for (const candidate of selectedCandidates) {
          ctx.log(`would import ${candidate.id} as ${mode} into ${target.scope}`);
        }
        await cancelPreparedSkillChange(
          daemonRequest,
          remotePreview !== null,
          control,
          change.changeId,
        );
        return;
      }
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Import ${selectedCandidates.length} skill(s) as ${mode} into ${target.scope}?`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          await cancelPreparedSkillChange(
            daemonRequest,
            remotePreview !== null,
            control,
            change.changeId,
          );
          ctx.log(`${verb} cancelled`);
          return;
        }
      }
      const commit = remotePreview
        ? await commitPreparedSkillChange<SkillImportCommit>(
            daemonRequest,
            change.changeId,
            "skill import",
          )
        : await control?.commit(change.changeId);
      if (!commit) throw new Error("skill import control plane is unavailable");
      ctx.log(`imported ${commit.result.imported.length} skill(s)`);
      return;
    }

    case "add-scope": {
      if (ctx.argv.rest.length !== 1) {
        throw new Error(
          "usage: ratel-local skill add-scope <id> --scope user|project|local [--mode reference|copy]",
        );
      }
      const runtime = createSkillReadRuntime(ctx, options);
      const context = await resolveSkillContext(
        ctx.argv.flags.project,
        ctx.env.projectRoot,
        runtime.registry,
      );
      const target = mutationTarget(ctx.argv.flags.scope, context);
      const mode = importMode(ctx.argv.flags.mode);
      const request = { context, target, id: ctx.argv.rest[0] as string, mode };
      const daemonRequest =
        options.daemonRequest ?? ((path, init) => requestRunningDaemon(ctx, path, init));
      const remotePreview = await daemonRequest(
        contextApiPath("/api/skills/add-scope/prepare", context),
        { method: "POST", body: request },
      );
      let control: SkillRegistrationControlPlane | undefined;
      let change: PreparedChange<SkillRegistrationReview>;
      if (remotePreview) {
        change = await requireDaemonJson<PreparedChange<SkillRegistrationReview>>(
          remotePreview,
          "skill add-scope preparation",
        );
      } else {
        control =
          options.registrationControlPlane ?? (await createRegistrationControlPlane(ctx, runtime));
        change = await control.prepareAddScope(request);
      }
      if (dryRun) {
        ctx.log(`would add ${request.id} as ${mode} to ${target.scope}`);
        await cancelPreparedSkillChange(
          daemonRequest,
          remotePreview !== null,
          control,
          change.changeId,
        );
        return;
      }
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Add ${request.id} as ${mode} to ${target.scope}?`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          await cancelPreparedSkillChange(
            daemonRequest,
            remotePreview !== null,
            control,
            change.changeId,
          );
          ctx.log("add-scope cancelled");
          return;
        }
      }
      const commit = remotePreview
        ? await commitPreparedSkillChange<SkillRegistrationCommit>(
            daemonRequest,
            change.changeId,
            "skill add-scope",
          )
        : await control?.commit(change.changeId);
      if (!commit) throw new Error("skill registration control plane is unavailable");
      ctx.log(`added ${request.id} to ${target.scope} (${commit.changedPaths.join(", ")})`);
      return;
    }

    case "remove-scope":
    case "remove": {
      if (ctx.argv.rest.length !== 1) {
        throw new Error(`usage: ratel-local skill ${verb} <id> --scope user|project|local`);
      }
      const runtime = createSkillReadRuntime(ctx, options);
      const context = await resolveSkillContext(
        ctx.argv.flags.project,
        ctx.env.projectRoot,
        runtime.registry,
      );
      const target = mutationTarget(ctx.argv.flags.scope, context);
      const request = {
        target,
        id: ctx.argv.rest[0] as string,
        deleteOwnedCopy: verb === "remove",
      };
      const control =
        options.registrationControlPlane ?? (await createRegistrationControlPlane(ctx, runtime));
      if (dryRun) {
        const change = await control.prepareRemove(request);
        ctx.log(`would update ${change.preview.files.map(({ path }) => path).join(", ")}`);
        control.cancel(change.changeId);
        return;
      }
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message:
            verb === "remove"
              ? `Remove ${request.id} from ${target.scope} and delete any owned copy?`
              : `Remove ${request.id} from ${target.scope}?`,
          initialValue: false,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          ctx.log(`${verb} cancelled`);
          return;
        }
      }
      const daemonRequest =
        options.daemonRequest ?? ((path, init) => requestRunningDaemon(ctx, path, init));
      const remote = await daemonRequest(
        contextApiPath(`/api/skills/${encodeURIComponent(request.id)}`, context),
        {
          method: "DELETE",
          body: { target, deleteOwnedCopy: request.deleteOwnedCopy },
        },
      );
      if (remote) {
        const commit = await requireDaemonJson<MutationCommit>(remote, `skill ${verb}`);
        ctx.log(`updated ${commit.changedPaths.join(", ")}`);
        return;
      }
      const commit = await control.remove(request);
      ctx.log(`updated ${commit.changedPaths.join(", ")}`);
      return;
    }

    case "list": {
      const runtime = createSkillReadRuntime(ctx, options);
      const context = await resolveSkillContext(
        ctx.argv.flags.project,
        undefined,
        runtime.registry,
      );
      const mode = listMode(ctx.argv.flags);
      if (mode === "discovered") {
        const project =
          context.kind === "project"
            ? await runtime.registry.resolve(context.projectId)
            : undefined;
        const result = await runtime.discovery.discover(
          project ? { kind: "project", projectRoot: project.canonicalRoot } : { kind: "global" },
        );
        if (ctx.argv.flags.format === "json") {
          ctx.log(JSON.stringify(result, null, 2));
        } else if (result.candidates.length === 0) {
          ctx.log("no discovered skills");
        } else {
          for (const candidate of result.candidates) {
            ctx.log(`${candidate.id}  [${candidate.source}]  ${candidate.canonicalPath}`);
          }
        }
        return;
      }
      const snapshot = await runtime.resolver.resolve(context);
      if (mode === "configured") {
        if (ctx.argv.flags.format === "json") {
          ctx.log(JSON.stringify(snapshot.skills.registrations, null, 2));
        } else if (snapshot.skills.registrations.length === 0) {
          ctx.log("no configured skills");
        } else {
          for (const registration of snapshot.skills.registrations) {
            ctx.log(
              `${registration.id}  [${registration.scopeRef.scope}/${registration.state}]  ${registration.configuredPath}`,
            );
          }
        }
        return;
      }
      if (ctx.argv.flags.format === "json") {
        ctx.log(JSON.stringify(snapshot.skills.effectiveSkills, null, 2));
      } else if (snapshot.skills.effectiveSkills.length === 0) {
        ctx.log("no effective skills");
      } else {
        for (const skill of snapshot.skills.effectiveSkills) {
          ctx.log(`${skill.id}  ${skill.description}`);
        }
      }
      return;
    }

    case "suggest": {
      const prompt = strFlag(ctx.argv.flags.prompt);
      if (!prompt) {
        ctx.log(
          'usage: ratel-local skill suggest --prompt "<text>" [--cwd <dir>] [--dir <path>]...',
        );
        return;
      }
      const cwd = strFlag(ctx.argv.flags.cwd);
      const dirs = dirsFlag(ctx.argv.flags.dir);
      let skills: Skill[] | undefined;
      if (!dirs) {
        const runtime = createSkillReadRuntime(ctx, options);
        const context = await resolveSkillContext(
          ctx.argv.flags.project,
          cwd ?? ctx.env.projectRoot,
          runtime.registry,
        );
        skills = (await runtime.resolver.resolve(context)).skills.effectiveSkills;
      }
      const suggestions = await suggestSkills({
        prompt,
        cwd,
        dirs,
        skills,
        limit: numFlag(ctx.argv.flags.limit) ?? 5,
        minScore: numFlag(ctx.argv.flags["min-score"]) ?? 0,
      });
      if (ctx.argv.flags.format === "json") {
        ctx.log(JSON.stringify(suggestions, null, 2));
        return;
      }
      if (suggestions.length === 0) {
        ctx.log("no matching skills");
        return;
      }
      for (const s of suggestions) {
        ctx.log(`${s.skillId}  (score ${s.score.toFixed(2)})  ${s.description}`);
      }
      return;
    }

    case "preload-hook": {
      // Hook entrypoint: read the UserPromptSubmit payload on stdin, inject a
      // pointer if a skill matches. Fail-open — never throw, never block.
      try {
        const input = parseHookInput(await readStdin());
        const dirs = dirsFlag(ctx.argv.flags.dir);
        let skills: Skill[] | undefined;
        if (!dirs) {
          const runtime = createSkillReadRuntime(ctx, options);
          const context = await resolveSkillContext(
            ctx.argv.flags.project,
            input.cwd ?? ctx.env.projectRoot,
            runtime.registry,
          );
          skills = (await runtime.resolver.resolve(context)).skills.effectiveSkills;
        }
        const stateDir = preloadStateDir(ctx.env.homeDir);
        const limit = numFlag(ctx.argv.flags.limit) ?? 1;
        const minScore = numFlag(ctx.argv.flags["min-score"]) ?? 0;
        // Cache project-signal detection across prompts: it only re-reads the
        // project's manifests when one changes, instead of on every keystroke-prompt.
        const signalCacheFile = defaultSignalCacheFile(ctx.env.homeDir);
        const additionalContext = await runPreloadHook(input, {
          suggest: (prompt, cwd) =>
            suggestSkills(
              { prompt, cwd, dirs, skills, limit, minScore, requireClearWinner: true },
              {
                detectProjectSignals: (c) =>
                  detectProjectSignalsCached(c, { cacheFile: signalCacheFile }),
              },
            ),
          loadNudged: (sessionId) => loadNudged(stateDir, sessionId),
          recordNudged: (sessionId, ids) => recordNudged(stateDir, sessionId, ids),
        });
        if (additionalContext) {
          // Claude Code reads the UserPromptSubmit hook's STDOUT for this JSON.
          // ctx.log is stderr (kept clean for human/diagnostic logs), so the
          // machine-read hook payload must go to stdout directly — otherwise the
          // injected context is silently dropped.
          process.stdout.write(
            `${JSON.stringify({
              hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
            })}\n`,
          );
        }
      } catch {
        // fail-open: inject nothing
      }
      return;
    }

    case "install-hook":
    case "uninstall-hook": {
      const scope = hookScope(ctx.argv.flags.scope);
      const settingsPath = settingsPathForScope(scope, ctx.env);
      const deps = { fs: ctx.fs, env: ctx.env };
      if (verb === "uninstall-hook") {
        const { changed } = ctx.preparedChanges
          ? (
              await ctx.preparedChanges.commit<{ changed: boolean }>(
                (
                  await prepareUninstallHook(settingsPath, deps, ctx.preparedChanges)
                ).changeId,
              )
            ).result
          : await uninstallHook(settingsPath, deps);
        ctx.log(
          changed ? `removed preload hook from ${settingsPath}` : "no preload hook to remove",
        );
        return;
      }
      const bin = await resolveCliRatelBin(ctx);
      const command = preloadHookCommand(bin);
      if (!assumeYes) {
        const answer = await ctx.prompts.confirm({
          message: `Add the Ratel skill-preload hook to ${settingsPath}?`,
          initialValue: true,
        });
        if (ctx.prompts.isCancel(answer) || answer === false) {
          ctx.log("install-hook cancelled");
          return;
        }
      }
      const { changed } = ctx.preparedChanges
        ? (
            await ctx.preparedChanges.commit<{ changed: boolean }>(
              (
                await prepareInstallHook(settingsPath, command, deps, ctx.preparedChanges)
              ).changeId,
            )
          ).result
        : await installHook(settingsPath, command, deps);
      ctx.log(
        changed ? `installed preload hook into ${settingsPath}` : "preload hook already installed",
      );
      return;
    }

    default:
      ctx.log(SKILL_USAGE);
  }
}

function contextApiPath(path: string, context: RuntimeContextRef): string {
  if (context.kind === "global") return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(context.projectId)}`;
}

async function commitPreparedSkillChange<T>(
  request: DaemonApiRequest,
  changeId: string,
  operation: string,
): Promise<T> {
  const response = await request(`/api/changes/${encodeURIComponent(changeId)}/commit`, {
    method: "POST",
  });
  if (!response) {
    throw new Error(
      `${operation} was prepared by the daemon, but the daemon disappeared before commit`,
    );
  }
  return requireDaemonJson<T>(response, operation);
}

async function cancelPreparedSkillChange(
  request: DaemonApiRequest,
  remote: boolean,
  control: SkillImportControlPlane | SkillRegistrationControlPlane | undefined,
  changeId: string,
): Promise<void> {
  if (!remote) {
    control?.cancel(changeId);
    return;
  }
  await request(`/api/changes/${encodeURIComponent(changeId)}`, { method: "DELETE" });
}

interface SkillReadRuntime {
  registry: ProjectRegistry;
  resolver: ContextSnapshotResolver;
  discovery: SkillDiscovery;
}

async function createRegistrationControlPlane(
  ctx: HandlerCtx,
  runtime: SkillReadRuntime,
): Promise<SkillRegistrationControlPlane> {
  const preparedChanges =
    ctx.preparedChanges ??
    createPreparedChangeCoordinator({
      mutationEngine: await createMutationEngine({
        controlDir: join(ctx.env.homeDir, ".ratel"),
      }),
    });
  const configControlPlane = await createConfigControlPlane({
    homeDir: ctx.env.homeDir,
    projectRegistry: runtime.registry,
    preparedChanges,
  });
  return createSkillRegistrationControlPlane({
    homeDir: ctx.env.homeDir,
    projectRegistry: runtime.registry,
    configControlPlane,
    snapshotResolver: runtime.resolver,
    preparedChanges,
    localGitExcludeManager: createLocalGitExcludeManager(),
  });
}

async function createImportControlPlane(
  ctx: HandlerCtx,
  runtime: SkillReadRuntime,
): Promise<SkillImportControlPlane> {
  const preparedChanges =
    ctx.preparedChanges ??
    createPreparedChangeCoordinator({
      mutationEngine: await createMutationEngine({
        controlDir: join(ctx.env.homeDir, ".ratel"),
      }),
    });
  return createSkillImportControlPlane({
    homeDir: ctx.env.homeDir,
    projectRegistry: runtime.registry,
    discovery: runtime.discovery,
    preparedChanges,
    localGitExcludeManager: createLocalGitExcludeManager(),
  });
}

function createSkillReadRuntime(ctx: HandlerCtx, options: SkillHandlerOptions): SkillReadRuntime {
  const registry = options.registry ?? createProjectRegistry({ homeDir: ctx.env.homeDir });
  const resolver =
    options.resolver ??
    createContextSnapshotResolver({ homeDir: ctx.env.homeDir, projectRegistry: registry });
  const discovery =
    options.discovery ??
    createSkillDiscovery({
      homeDir: ctx.env.homeDir,
      registeredProjectRoots: async () =>
        (await registry.list())
          .filter((project) => project.status === "available")
          .map((project) => project.canonicalRoot),
    });
  return { registry, resolver, discovery };
}

async function resolveSkillContext(
  projectFlag: FlagValue | undefined,
  fallbackPath: string | undefined,
  registry: ProjectRegistry,
): Promise<RuntimeContextRef> {
  if (projectFlag !== undefined && typeof projectFlag !== "string") {
    throw new Error("--project requires a registered project id or path");
  }
  const selector = projectFlag ?? fallbackPath;
  if (!selector) return { kind: "global" };
  try {
    const project = await registry.resolve(selector as ProjectId);
    return { kind: "project", projectId: project.id };
  } catch (error) {
    if (selector.startsWith("prj_") || !(error instanceof ProjectNotFoundError)) throw error;
  }
  const project = await registry.registerRoot(selector);
  return { kind: "project", projectId: project.id };
}

function listMode(flags: HandlerCtx["argv"]["flags"]): "effective" | "configured" | "discovered" {
  const selected = (["effective", "configured", "discovered"] as const).filter(
    (mode) => flags[mode] === true,
  );
  if (selected.length > 1) {
    throw new Error("choose only one of --effective, --configured, or --discovered");
  }
  return selected[0] ?? "effective";
}

function strFlag(v: FlagValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numFlag(v: FlagValue | undefined): number | undefined {
  const s = strFlag(v);
  if (s === undefined || s.trim() === "") return undefined; // empty/blank is not 0
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function dirsFlag(v: FlagValue | undefined): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v;
  return undefined;
}

function hookScope(v: FlagValue | undefined): HookScope {
  return v === "project" ? "project" : "user";
}

function mutationTarget(
  value: FlagValue | undefined,
  context: RuntimeContextRef,
): { scope: "user" } | { scope: "project" | "local"; projectId: ProjectId } {
  const scope = value ?? "user";
  if (scope === "user") return { scope: "user" };
  if (scope !== "project" && scope !== "local") {
    throw new Error("--scope must be one of user|project|local");
  }
  if (context.kind !== "project") {
    throw new Error(`--scope ${scope} requires --project or a project cwd`);
  }
  return { scope, projectId: context.projectId };
}

function importMode(value: FlagValue | undefined): "reference" | "copy" {
  if (value === undefined) return "reference";
  if (value === "reference" || value === "copy") return value;
  throw new Error("--mode must be reference|copy");
}

async function selectImportCandidates(
  ctx: HandlerCtx,
  candidates: Awaited<ReturnType<SkillDiscovery["discover"]>>["candidates"],
  requested: readonly string[],
) {
  if (requested.length > 0) {
    return requested.map((selector) => {
      const matches = candidates.filter(
        ({ id, candidateId }) => id === selector || candidateId === selector,
      );
      if (matches.length === 0) throw new Error(`unknown discovered skill: ${selector}`);
      if (matches.length > 1) {
        throw new Error(`ambiguous discovered skill ${selector}; use its candidateId`);
      }
      return matches[0] as (typeof candidates)[number];
    });
  }
  if (candidates.length === 0) return [];
  const selected = await ctx.prompts.multiselect({
    message: "Select skills to import",
    options: candidates.map((candidate) => ({
      value: candidate.candidateId,
      label: `${candidate.id} [${candidate.source}]`,
      hint: candidate.canonicalPath,
    })),
    required: true,
  });
  if (ctx.prompts.isCancel(selected)) return [];
  const selectedIds = new Set(selected as string[]);
  return candidates.filter(({ candidateId }) => selectedIds.has(candidateId));
}
