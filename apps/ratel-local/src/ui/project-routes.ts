import type {
  ProjectAdmissionLock,
  ProjectRegistry,
  ProjectView,
} from "@ratel-ai/ratel-local-core";
import type { ActiveMcpClientReader, ApiResponse } from "./routes.js";

export type CanForgetProject = (project: ProjectView) => boolean | Promise<boolean>;

export interface ProjectRouteDependencies {
  registry: ProjectRegistry;
  canForgetProject?: CanForgetProject;
  clients?: ActiveMcpClientReader;
  admissionLock?: ProjectAdmissionLock;
}

export async function getProjectsRoute(
  dependencies: ProjectRouteDependencies,
): Promise<ApiResponse> {
  const projects = await dependencies.registry.list();
  const clients = dependencies.clients?.listActiveClients() ?? [];
  return {
    status: 200,
    body: {
      projects: projects.map(({ id, ...project }) => {
        const projectClients = clients.filter(
          (client) =>
            (client.context.kind === "project" && client.context.projectId === id) ||
            client.projectRoot === project.canonicalRoot,
        );
        const latest = [...projectClients].sort((a, b) =>
          b.lastSeenAt.localeCompare(a.lastSeenAt),
        )[0];
        const runtimeRevision =
          dependencies.clients?.currentRevision?.({ kind: "project", projectId: id }) ??
          latest?.runtimeRevision;
        return {
          projectId: id,
          ...project,
          connected: projectClients.length > 0,
          clientCount: projectClients.length,
          staleClientCount: projectClients.filter((client) => client.stale).length,
          ...(runtimeRevision ? { runtimeRevision } : {}),
        };
      }),
    },
  };
}

export async function addProjectRoute(
  dependencies: ProjectRouteDependencies,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const path = body.path;
  const displayName = body.displayName;
  if (typeof path !== "string" || path.trim().length === 0) {
    return { status: 400, body: { error: "path must be a non-empty string" } };
  }
  if (
    displayName !== undefined &&
    (typeof displayName !== "string" || displayName.trim().length === 0)
  ) {
    return { status: 400, body: { error: "displayName must be a non-empty string" } };
  }

  const register = () =>
    dependencies.registry.registerRoot(path, displayName as string | undefined);
  const project = dependencies.admissionLock
    ? await dependencies.admissionLock.run(register)
    : await register();
  const { id, ...view } = project;
  return { status: 201, body: { project: { projectId: id, ...view } } };
}

export async function deleteProjectRoute(
  dependencies: ProjectRouteDependencies,
  projectId: string,
): Promise<ApiResponse> {
  const remove = () => deleteProjectUnderAdmission(dependencies, projectId);
  return dependencies.admissionLock ? dependencies.admissionLock.run(remove) : remove();
}

async function deleteProjectUnderAdmission(
  dependencies: ProjectRouteDependencies,
  projectId: string,
): Promise<ApiResponse> {
  const project = (await dependencies.registry.list()).find(({ id }) => id === projectId);
  if (!project) {
    return { status: 404, body: { error: `unknown project: ${projectId}` } };
  }
  if (project.status === "missing") {
    return { status: 409, body: { error: `project root is missing: ${projectId}` } };
  }
  if (dependencies.canForgetProject && !(await dependencies.canForgetProject(project))) {
    return { status: 409, body: { error: `project is active: ${projectId}` } };
  }
  await dependencies.registry.forget(project.id);
  return { status: 200, body: { projectId: project.id } };
}
