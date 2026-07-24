import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type {
  ProjectAdmissionLock,
  ProjectContext,
  ProjectRegistry,
} from "@ratel-ai/ratel-local-core";
import { ArgError } from "../args.js";
import { requestRunningDaemon, requireDaemonJson } from "../daemon-api.js";
import type { HandlerCtx } from "./types.js";

export const PROJECT_USAGE = `usage: ratel-local project <verb> [args...]

Verbs:
  list                 list registered project roots
  add <path>           register a project root
  remove <id-or-path>  forget a project without deleting its files`;

export interface ProjectHandlerDependencies {
  registry: ProjectRegistry;
  canonicalizePath?: (path: string) => Promise<string>;
  admissionLock?: ProjectAdmissionLock;
  /** Returns true when the running daemon admitted and performed the forget. */
  removeThroughDaemon?: (projectId: string) => Promise<boolean>;
  /** Returns the registered context when a running daemon admitted the add. */
  addThroughDaemon?: (path: string) => Promise<ProjectContext | null>;
}

export async function runProject(
  ctx: HandlerCtx,
  dependencies: ProjectHandlerDependencies,
): Promise<void> {
  switch (ctx.argv.verb) {
    case "list":
      await listProjects(ctx, dependencies.registry);
      return;
    case "add":
      await addProject(ctx, dependencies);
      return;
    case "remove":
      await removeProject(ctx, dependencies);
      return;
    default:
      throw new ArgError(`unknown project verb: ${ctx.argv.verb}`);
  }
}

async function removeProject(
  ctx: HandlerCtx,
  dependencies: ProjectHandlerDependencies,
): Promise<void> {
  if (ctx.argv.rest.length !== 1) {
    throw new ArgError("usage: ratel-local project remove <id-or-path>");
  }
  const input = ctx.argv.rest[0];
  const project = await resolveProjectInput(input, dependencies);
  // Never hold the cross-process admission lock while calling the daemon: its
  // DELETE route takes the same lock before checking sessions and leases.
  if (await dependencies.removeThroughDaemon?.(project.id)) {
    ctx.log(`forgot ${project.id}  ${project.canonicalRoot}`);
    return;
  }

  const removeLocal = async () => {
    const current = await resolveProjectInput(input, dependencies);
    if (current.status === "missing") {
      throw new ArgError(
        `cannot forget missing project until its root is available: ${current.id}`,
      );
    }
    await dependencies.registry.forget(current.id);
    ctx.log(`forgot ${current.id}  ${current.canonicalRoot}`);
  };
  return dependencies.admissionLock ? dependencies.admissionLock.run(removeLocal) : removeLocal();
}

async function resolveProjectInput(input: string, dependencies: ProjectHandlerDependencies) {
  const projects = await dependencies.registry.list();
  let project = projects.find(({ id }) => id === input);
  if (!project) {
    const absolutePath = resolvePath(input);
    const canonicalPath = await (dependencies.canonicalizePath ?? realpath)(absolutePath).catch(
      () => absolutePath,
    );
    project = projects.find(
      ({ canonicalRoot }) => canonicalRoot === canonicalPath || canonicalRoot === absolutePath,
    );
  }
  if (!project) throw new ArgError(`unknown project: ${input}`);
  return project;
}

async function addProject(
  ctx: HandlerCtx,
  dependencies: ProjectHandlerDependencies,
): Promise<void> {
  if (ctx.argv.rest.length !== 1) {
    throw new ArgError("usage: ratel-local project add <path>");
  }
  const input = ctx.argv.rest[0];
  const project =
    (await dependencies.addThroughDaemon?.(input)) ??
    (await addProjectThroughRunningDaemon(ctx, input)) ??
    (await dependencies.registry.registerRoot(input));
  ctx.log(`registered ${project.id}  ${project.displayName}  ${project.canonicalRoot}`);
}

async function addProjectThroughRunningDaemon(
  ctx: HandlerCtx,
  path: string,
): Promise<ProjectContext | null> {
  const response = await requestRunningDaemon(ctx, "/api/projects", {
    method: "POST",
    // Relative paths belong to the invoking CLI process, never to the daemon's cwd.
    body: { path: resolvePath(path) },
  });
  if (!response) return null;
  const body = await requireDaemonJson<{
    project: Omit<ProjectContext, "id"> & { projectId: ProjectContext["id"] };
  }>(response, "project add");
  const { projectId, ...project } = body.project;
  return { id: projectId, ...project };
}

async function listProjects(ctx: HandlerCtx, registry: ProjectRegistry): Promise<void> {
  const projects = await registry.list();
  if (projects.length === 0) {
    ctx.log("no projects registered");
    return;
  }
  for (const project of projects) {
    ctx.log(`${project.id}  [${project.status}]  ${project.displayName}  ${project.canonicalRoot}`);
  }
}
