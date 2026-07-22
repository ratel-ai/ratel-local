import { describe, expect, it } from "vitest";
import {
  contextPagePath,
  contextualizeApiPath,
  legacyGlobalPath,
  pageSuffixFromPathname,
  runtimeContextFromPathname,
  safeRememberedRoute,
  scopeTarget,
} from "./runtime-context";

describe("runtime context navigation", () => {
  it("derives global, all-projects, and project contexts from the URL", () => {
    expect(runtimeContextFromPathname("/global/skills")).toEqual({ kind: "global" });
    expect(runtimeContextFromPathname("/all")).toEqual({ kind: "all" });
    expect(runtimeContextFromPathname("/projects/prj_a%2Fb/clients")).toEqual({
      kind: "project",
      projectId: "prj_a/b",
    });
  });

  it("builds page links inside the current context", () => {
    expect(contextPagePath({ kind: "global" }, "/skills")).toBe("/global/skills");
    expect(contextPagePath({ kind: "project", projectId: "prj_123" }, "/tools/new")).toBe(
      "/projects/prj_123/tools/new",
    );
    expect(contextPagePath({ kind: "all" }, "/skills")).toBe("/all");
    expect(pageSuffixFromPathname("/projects/prj_123/tools/user/github")).toBe(
      "/tools/user/github",
    );
    expect(pageSuffixFromPathname("/all")).toBe("/");
  });

  it("adds the project id to scoped reads and mutations", () => {
    const project = { kind: "project", projectId: "prj_a/b" } as const;
    expect(contextualizeApiPath("/api/config", project)).toBe("/api/config?projectId=prj_a%2Fb");
    expect(contextualizeApiPath("/api/skills?view=effective", project)).toBe(
      "/api/skills?view=effective&projectId=prj_a%2Fb",
    );
    expect(contextualizeApiPath("/api/agent-hosts", project)).toBe(
      "/api/agent-hosts?projectId=prj_a%2Fb",
    );
    expect(contextualizeApiPath("/api/mcp-clients", project)).toBe(
      "/api/mcp-clients?projectId=prj_a%2Fb",
    );
    expect(contextualizeApiPath("/api/projects", project)).toBe("/api/projects");
    expect(contextualizeApiPath("/api/servers/github", project, "PATCH")).toBe(
      "/api/servers/github?projectId=prj_a%2Fb",
    );
    expect(contextualizeApiPath("/api/auth/github", project, "POST")).toBe(
      "/api/auth/github?projectId=prj_a%2Fb",
    );
    expect(contextualizeApiPath("/api/agents/link/prepare", project, "POST")).toBe(
      "/api/agents/link/prepare?projectId=prj_a%2Fb",
    );
    expect(contextualizeApiPath("/api/config", { kind: "global" })).toBe("/api/config");
  });

  it("builds only valid discriminated mutation targets", () => {
    expect(scopeTarget({ kind: "global" }, "user")).toEqual({ scope: "user" });
    expect(scopeTarget({ kind: "project", projectId: "prj_1" }, "local")).toEqual({
      scope: "local",
      projectId: "prj_1",
    });
    expect(() => scopeTarget({ kind: "global" }, "project")).toThrow(/project context/i);
  });

  it("maps legacy routes to the global context for compatibility", () => {
    expect(legacyGlobalPath("/")).toBe("/global");
    expect(legacyGlobalPath("/tools/user/github")).toBe("/global/tools/user/github");
    expect(legacyGlobalPath("/global/skills")).toBeNull();
    expect(legacyGlobalPath("/projects/prj_1/skills")).toBeNull();
  });

  it("accepts only scoped local routes from storage", () => {
    expect(safeRememberedRoute("/projects/prj_1/skills")).toBe("/projects/prj_1/skills");
    expect(safeRememberedRoute("/global/clients")).toBe("/global/clients");
    expect(safeRememberedRoute("https://example.com/steal")).toBeNull();
    expect(safeRememberedRoute("/tools/user/foo")).toBeNull();
  });
});
