export type ProjectId = string & { readonly __brand: "ProjectId" };
export type DocumentRevision = string & { readonly __brand: "DocumentRevision" };
export type RuntimeRevision = string & { readonly __brand: "RuntimeRevision" };

export type RuntimeContextRef = { kind: "global" } | { kind: "project"; projectId: ProjectId };

export type RatelScopeRef =
  | { scope: "user" }
  | { scope: "project" | "local"; projectId: ProjectId };

export type AgentLinkScope = "user" | "project" | "local";
