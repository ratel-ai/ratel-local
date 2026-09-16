import { isPlainObject } from "@ratel-ai/ratel-local-core/json";

export interface ProjectView {
  id: string;
  canonicalRoot: string;
  displayName?: string;
  lastSeenAt?: string;
  available?: boolean;
  missing?: boolean;
  connected?: boolean;
  clientCount?: number;
  staleClientCount?: number;
  runtimeRevision?: string;
  status?: "available" | "missing";
}

export function projectsFromResponse(body: unknown): ProjectView[] {
  const input = Array.isArray(body)
    ? body
    : isPlainObject(body) && Array.isArray(body.projects)
      ? body.projects
      : [];

  return input.flatMap((item) => {
    const id = isPlainObject(item)
      ? typeof item.projectId === "string"
        ? item.projectId
        : typeof item.id === "string"
          ? item.id
          : null
      : null;
    if (!isPlainObject(item) || id === null || typeof item.canonicalRoot !== "string") {
      return [];
    }

    const project: ProjectView = {
      id,
      canonicalRoot: item.canonicalRoot,
    };
    if (typeof item.displayName === "string") project.displayName = item.displayName;
    if (typeof item.lastSeenAt === "string") project.lastSeenAt = item.lastSeenAt;
    if (typeof item.available === "boolean") project.available = item.available;
    if (typeof item.missing === "boolean") project.missing = item.missing;
    if (typeof item.connected === "boolean") project.connected = item.connected;
    if (typeof item.clientCount === "number") project.clientCount = item.clientCount;
    if (typeof item.staleClientCount === "number") {
      project.staleClientCount = item.staleClientCount;
    }
    if (typeof item.runtimeRevision === "string") project.runtimeRevision = item.runtimeRevision;
    if (item.status === "available" || item.status === "missing") project.status = item.status;
    return [project];
  });
}

export function projectLabel(project: ProjectView): string {
  if (project.displayName?.trim()) return project.displayName;
  const segments = project.canonicalRoot.split("/").filter(Boolean);
  return segments.at(-1) ?? project.id;
}
