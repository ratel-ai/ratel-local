import type { ProjectAdmissionLock, ProjectId, ProjectRegistry } from "@ratel-ai/ratel-local-core";
import { describe, expect, it } from "vitest";
import { silentPromptAdapter } from "../prompts.js";
import { runProject } from "./project.js";
import type { HandlerCtx } from "./types.js";

const PROJECT_ID = "prj_test-project" as ProjectId;

function registry(overrides: Partial<ProjectRegistry> = {}): ProjectRegistry {
  return {
    registerRoot: async () => {
      throw new Error("unexpected registerRoot");
    },
    resolve: async () => {
      throw new Error("unexpected resolve");
    },
    list: async () => [],
    touch: async () => {},
    forget: async () => {
      throw new Error("unexpected forget");
    },
    ...overrides,
  };
}

function ctx(verb: string, rest: string[], log: (message: string) => void): HandlerCtx {
  return {
    argv: { group: "project", verb, configPaths: [], rest, extras: [], flags: {} },
    env: { homeDir: "/home/u" },
    fs: {} as HandlerCtx["fs"],
    log,
    prompts: silentPromptAdapter(),
  };
}

describe("runProject", () => {
  it("lists registered projects with availability and canonical roots", async () => {
    const logs: string[] = [];

    await runProject(
      ctx("list", [], (message) => logs.push(message)),
      {
        registry: registry({
          list: async () => [
            {
              id: PROJECT_ID,
              canonicalRoot: "/repo",
              displayName: "Ratel",
              lastSeenAt: "2026-07-15T12:00:00.000Z",
              status: "available",
            },
          ],
        }),
      },
    );

    expect(logs).toEqual(["prj_test-project  [available]  Ratel  /repo"]);
  });

  it("registers the requested project path", async () => {
    const addedPaths: string[] = [];
    const logs: string[] = [];

    await runProject(
      ctx("add", ["/repo"], (message) => logs.push(message)),
      {
        registry: registry({
          registerRoot: async (path) => {
            addedPaths.push(path);
            return {
              id: PROJECT_ID,
              canonicalRoot: "/canonical/repo",
              displayName: "repo",
              lastSeenAt: "2026-07-15T12:00:00.000Z",
            };
          },
        }),
      },
    );

    expect(addedPaths).toEqual(["/repo"]);
    expect(logs).toEqual(["registered prj_test-project  repo  /canonical/repo"]);
  });

  it("delegates project registration to the running daemon before the local registry", async () => {
    let localRegisterCalled = false;
    const logs: string[] = [];

    await runProject(
      ctx("add", ["/repo"], (message) => logs.push(message)),
      {
        registry: registry({
          registerRoot: async () => {
            localRegisterCalled = true;
            throw new Error("local fallback should not run");
          },
        }),
        addThroughDaemon: async (path) => {
          expect(path).toBe("/repo");
          return {
            id: PROJECT_ID,
            canonicalRoot: "/canonical/repo",
            displayName: "repo",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
          };
        },
      },
    );

    expect(localRegisterCalled).toBe(false);
    expect(logs).toEqual(["registered prj_test-project  repo  /canonical/repo"]);
  });

  it("forgets a registered project by id without touching project files", async () => {
    const forgotten: ProjectId[] = [];
    const logs: string[] = [];
    const admissions: string[] = [];
    const admissionLock: ProjectAdmissionLock = {
      async run(operation) {
        admissions.push("admitted");
        return operation();
      },
    };

    await runProject(
      ctx("remove", [PROJECT_ID], (message) => logs.push(message)),
      {
        registry: registry({
          list: async () => [
            {
              id: PROJECT_ID,
              canonicalRoot: "/repo",
              displayName: "Ratel",
              lastSeenAt: "2026-07-15T12:00:00.000Z",
              status: "available",
            },
          ],
          forget: async (projectId) => {
            forgotten.push(projectId);
          },
        }),
        admissionLock,
      },
    );

    expect(forgotten).toEqual([PROJECT_ID]);
    expect(admissions).toEqual(["admitted"]);
    expect(logs).toEqual(["forgot prj_test-project  /repo"]);
  });

  it("resolves a path alias before forgetting a project", async () => {
    const forgotten: ProjectId[] = [];

    await runProject(
      ctx("remove", ["/repo-alias"], () => {}),
      {
        registry: registry({
          list: async () => [
            {
              id: PROJECT_ID,
              canonicalRoot: "/repo",
              displayName: "Ratel",
              lastSeenAt: "2026-07-15T12:00:00.000Z",
              status: "available",
            },
          ],
          forget: async (projectId) => {
            forgotten.push(projectId);
          },
        }),
        canonicalizePath: async (path) => {
          expect(path).toBe("/repo-alias");
          return "/repo";
        },
      },
    );

    expect(forgotten).toEqual([PROJECT_ID]);
  });

  it("delegates removal to a running daemon so active lease admission is authoritative", async () => {
    const remote: string[] = [];
    let localForgetCalled = false;
    let localAdmissionCalled = false;
    await runProject(
      ctx("remove", [PROJECT_ID], () => {}),
      {
        registry: registry({
          list: async () => [
            {
              id: PROJECT_ID,
              canonicalRoot: "/repo",
              displayName: "Ratel",
              lastSeenAt: "2026-07-15T12:00:00.000Z",
              status: "available",
            },
          ],
          forget: async () => {
            localForgetCalled = true;
          },
        }),
        removeThroughDaemon: async (projectId) => {
          remote.push(projectId);
          return true;
        },
        admissionLock: {
          async run(operation) {
            localAdmissionCalled = true;
            return operation();
          },
        },
      },
    );

    expect(remote).toEqual([PROJECT_ID]);
    expect(localForgetCalled).toBe(false);
    expect(localAdmissionCalled).toBe(false);
  });
});
