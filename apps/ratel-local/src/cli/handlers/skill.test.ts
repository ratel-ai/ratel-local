import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type ContextSnapshotResolver,
  type ProjectId,
  ProjectNotFoundError,
  type ProjectRegistry,
  type ResolvedContextSnapshot,
  type RuntimeContextRef,
  type SkillImportControlPlane,
  type SkillRegistrationControlPlane,
} from "@ratel-ai/ratel-local-core";
import type { Skill } from "@ratel-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentPromptAdapter } from "../prompts.js";
import { runSkill } from "./skill.js";
import type { HandlerCtx } from "./types.js";

const PROJECT_ID = `prj_${"a".repeat(43)}` as ProjectId;
const EFFECTIVE_SKILL: Skill = {
  id: "project-review",
  name: "project-review",
  description: "Review this project",
  tags: ["review"],
  metadata: { stacks: [] },
  body: "Review instructions",
};

function snapshot(context: RuntimeContextRef): ResolvedContextSnapshot {
  return {
    context,
    ...(context.kind === "project" ? { projectRoot: "/repo" } : {}),
    documents: [],
    runtimeRevision: "rev" as ResolvedContextSnapshot["runtimeRevision"],
    mcpEntries: [],
    skills: {
      effectiveSkills: [EFFECTIVE_SKILL],
      registrations: [],
      diagnostics: [],
      fingerprint: "skills",
      watchInputs: [],
    },
    diagnostics: [],
    watchInputs: [],
  };
}

function registry(): ProjectRegistry {
  return {
    registerRoot: async () => {
      throw new Error("path registration should not run for an id");
    },
    resolve: async (id) => {
      if (id !== PROJECT_ID) throw new Error(`unknown ${id}`);
      return {
        id: PROJECT_ID,
        canonicalRoot: "/repo",
        displayName: "repo",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
    },
    list: async () => [],
    touch: async () => {},
    forget: async () => {},
  };
}

function listCtx(log: (line: string) => void): HandlerCtx {
  return {
    argv: {
      group: "skill",
      verb: "list",
      configPaths: [],
      rest: [],
      extras: [],
      flags: { project: PROJECT_ID, effective: true },
    },
    env: { homeDir: "/home/u" },
    fs: {} as HandlerCtx["fs"],
    log,
    prompts: silentPromptAdapter(),
  };
}

// The `preload-hook` verb is a Claude Code `UserPromptSubmit` hook: Claude Code
// reads the injected context from the hook's STDOUT. ctx.log is stderr (kept
// clean for diagnostics), so the nudge JSON must be written to stdout directly.
// Regression: it once went to stderr, and the entire push path silently
// injected nothing in real Claude Code while every unit test still passed.

function hookCtx(homeDir: string, log: (m: string) => void): HandlerCtx {
  return {
    argv: {
      group: "skill",
      verb: "preload-hook",
      configPaths: [],
      rest: [],
      extras: [],
      flags: {},
    },
    env: { homeDir },
    fs: {} as unknown as HandlerCtx["fs"], // preload-hook never touches ctx.fs
    log,
    prompts: silentPromptAdapter(),
  };
}

describe("runSkill — preload-hook output stream", () => {
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");

  afterEach(() => {
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
    vi.restoreAllMocks();
  });

  it("writes the UserPromptSubmit nudge to STDOUT, not via the stderr logger", async () => {
    const home = await mkdtemp(join(tmpdir(), "ratel-hook-"));
    try {
      const skillDir = join(home, ".ratel", "skills", "frontend-react");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: frontend-react\ndescription: React UI patterns.\ntriggers: [dashboard, page, form]\nstacks: [react, next]\n---\nBODY\n",
      );
      const proj = join(home, "proj");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, "package.json"),
        JSON.stringify({ dependencies: { next: "15", react: "19" } }),
      );

      const payload = JSON.stringify({
        prompt: "build me a dashboard",
        cwd: proj,
        session_id: "t1",
      });
      Object.defineProperty(process, "stdin", {
        value: Readable.from([Buffer.from(payload)]),
        configurable: true,
      });
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderrLines: string[] = [];

      await runSkill(hookCtx(home, (m) => stderrLines.push(m)));

      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("hookSpecificOutput");
      expect(out).toContain("frontend-react");
      // The machine-read payload must NOT have gone to the stderr logger.
      expect(stderrLines.join("\n")).not.toContain("hookSpecificOutput");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runSkill — snapshot-backed reads", () => {
  it("imports a discovered candidate into an explicit target", async () => {
    const previews: unknown[] = [];
    const applies: unknown[] = [];
    const plan = { id: "tx", digest: "import-digest" } as never;
    const importControlPlane: SkillImportControlPlane = {
      async preview(selections) {
        previews.push(selections);
        return plan;
      },
      async apply(submitted, options) {
        applies.push({ submitted, options });
        return { transactionId: "tx", changedPaths: [], revisions: {}, imported: [] };
      },
    };
    const ctx = listCtx(() => {});
    ctx.argv.verb = "import";
    ctx.argv.rest = ["native-review"];
    ctx.argv.flags = {
      project: PROJECT_ID,
      scope: "project",
      mode: "reference",
      yes: true,
    };
    const discovery = {
      async discover() {
        return {
          candidates: [
            {
              candidateId: "cand_native",
              id: "native-review",
              name: "native-review",
              description: "Native review",
              source: "codex-current" as const,
              canonicalPath: "/repo/.agents/skills/native-review",
              context: { kind: "project" as const, projectRoot: "/repo" },
              digest: "digest",
            },
          ],
          diagnostics: [],
          visitedDirectories: 1,
          truncated: false,
          timedOut: false,
        };
      },
      async resolveCandidate() {
        throw new Error("control plane owns candidate resolution");
      },
    };

    await runSkill(ctx, {
      registry: registry(),
      discovery,
      importControlPlane,
    });

    expect(previews).toEqual([
      [
        {
          candidateId: "cand_native",
          targets: [
            {
              scopeRef: { scope: "project", projectId: PROJECT_ID },
              mode: "reference",
            },
          ],
        },
      ],
    ]);
    expect(applies).toEqual([{ submitted: plan, options: { digest: "import-digest" } }]);
  });

  it("keeps a daemon-created skill import preview on the daemon for apply", async () => {
    const calls: Array<{ path: string; init: unknown }> = [];
    const remotePlan = { id: "remote", digest: "remote-digest" } as never;
    const remoteCandidate = {
      candidateId: "cand_remote",
      id: "native-review",
      name: "native-review",
      description: "Native review",
      source: "codex-current" as const,
      canonicalPath: "/repo/.agents/skills/native-review",
      context: { kind: "project" as const, projectRoot: "/repo" },
      digest: "digest",
    };
    const ctx = listCtx(() => {});
    ctx.argv.verb = "import";
    ctx.argv.rest = ["native-review"];
    ctx.argv.flags = { project: PROJECT_ID, scope: "project", mode: "copy", yes: true };
    const discovery = {
      async discover() {
        return {
          candidates: [remoteCandidate],
          diagnostics: [],
          visitedDirectories: 1,
          truncated: false,
          timedOut: false,
        };
      },
      async resolveCandidate() {
        throw new Error("the daemon resolves candidates");
      },
    };

    await runSkill(ctx, {
      registry: registry(),
      discovery,
      daemonRequest: async (path, init) => {
        calls.push({ path, init });
        if (path.startsWith("/api/skills?")) {
          return Response.json({ discovered: [remoteCandidate] });
        }
        return Response.json(
          path.includes("/preview")
            ? remotePlan
            : { transactionId: "remote", changedPaths: [], revisions: {}, imported: [{}] },
        );
      },
    });

    expect(calls).toEqual([
      {
        path: `/api/skills?projectId=${PROJECT_ID}`,
        init: undefined,
      },
      {
        path: `/api/skills/import/preview?projectId=${PROJECT_ID}`,
        init: {
          method: "POST",
          body: {
            selections: [
              {
                candidateId: "cand_remote",
                targets: [
                  {
                    scopeRef: { scope: "project", projectId: PROJECT_ID },
                    mode: "copy",
                  },
                ],
              },
            ],
          },
        },
      },
      {
        path: `/api/skills/import/apply?projectId=${PROJECT_ID}`,
        init: {
          method: "POST",
          body: { plan: remotePlan, digest: "remote-digest" },
        },
      },
    ]);
  });

  it("add-scope uses an existing effective registration without discovery", async () => {
    const calls: unknown[] = [];
    const plan = { id: "tx", digest: "scope-digest", preview: { files: [] } } as never;
    const registrationControlPlane = {
      async previewAddScope(request: unknown) {
        calls.push({ preview: request });
        return plan;
      },
      async apply(submitted: unknown, options: unknown) {
        calls.push({ apply: { submitted, options } });
        return { transactionId: "tx", changedPaths: ["/repo/.ratel/config.json"], revisions: {} };
      },
    } as unknown as SkillRegistrationControlPlane;
    const ctx = listCtx(() => {});
    ctx.argv.verb = "add-scope";
    ctx.argv.rest = ["project-review"];
    ctx.argv.flags = {
      project: PROJECT_ID,
      scope: "project",
      mode: "reference",
      yes: true,
    };

    await runSkill(ctx, {
      registry: registry(),
      registrationControlPlane,
    });

    expect(calls).toEqual([
      {
        preview: {
          context: { kind: "project", projectId: PROJECT_ID },
          target: { scope: "project", projectId: PROJECT_ID },
          id: "project-review",
          mode: "reference",
        },
      },
      { apply: { submitted: plan, options: { digest: "scope-digest" } } },
    ]);
  });

  it.each([
    ["remove-scope", false],
    ["remove", true],
  ] as const)("%s targets an explicit scoped registration", async (verb, deleteOwnedCopy) => {
    const calls: unknown[] = [];
    const registrationControlPlane = {
      async previewRemove() {
        throw new Error("previewRemove should be encapsulated by remove");
      },
      async apply() {
        throw new Error("apply should be encapsulated by remove");
      },
      async remove(request) {
        calls.push(request);
        return { transactionId: "tx", changedPaths: [], revisions: {} };
      },
    } satisfies SkillRegistrationControlPlane;
    const ctx = listCtx(() => {});
    ctx.argv.verb = verb;
    ctx.argv.rest = ["project-review"];
    ctx.argv.flags = { project: PROJECT_ID, scope: "project", yes: true };

    await runSkill(ctx, { registry: registry(), registrationControlPlane });

    expect(calls).toEqual([
      {
        target: { scope: "project", projectId: PROJECT_ID },
        id: "project-review",
        deleteOwnedCopy,
      },
    ]);
  });

  it("lists the effective catalog for a registered project id", async () => {
    const contexts: RuntimeContextRef[] = [];
    const resolver: ContextSnapshotResolver = {
      resolve: async (context) => {
        contexts.push(context);
        return snapshot(context);
      },
    };
    const logs: string[] = [];

    await runSkill(
      listCtx((line) => logs.push(line)),
      { registry: registry(), resolver },
    );

    expect(contexts).toEqual([{ kind: "project", projectId: PROJECT_ID }]);
    expect(logs.join("\n")).toContain("project-review");
    expect(logs.join("\n")).toContain("Review this project");
  });

  it("tries a registered id first, then registers a valid project path", async () => {
    const calls: string[] = [];
    const projectRegistry: ProjectRegistry = {
      ...registry(),
      resolve: async (id) => {
        calls.push(`resolve:${id}`);
        throw new ProjectNotFoundError(id);
      },
      registerRoot: async (path) => {
        calls.push(`register:${path}`);
        return {
          id: PROJECT_ID,
          canonicalRoot: path,
          displayName: "repo",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        };
      },
    };
    const contexts: RuntimeContextRef[] = [];
    const resolver: ContextSnapshotResolver = {
      resolve: async (context) => {
        contexts.push(context);
        return snapshot(context);
      },
    };
    const ctx = listCtx(() => {});
    ctx.argv.flags.project = "/repo";

    await runSkill(ctx, { registry: projectRegistry, resolver });

    expect(calls).toEqual(["resolve:/repo", "register:/repo"]);
    expect(contexts).toEqual([{ kind: "project", projectId: PROJECT_ID }]);
  });

  it("lists configured registrations with scope and state", async () => {
    const resolved = snapshot({ kind: "project", projectId: PROJECT_ID });
    resolved.skills.registrations.push({
      ref: {
        scopeRef: { scope: "project", projectId: PROJECT_ID },
        id: "project-review",
        kind: "entry",
        configuredPath: ".agents/skills/review",
      },
      id: "project-review",
      mode: "reference",
      source: "codex",
      scopeRef: { scope: "project", projectId: PROJECT_ID },
      configuredPath: ".agents/skills/review",
      state: "shadowed",
      editable: false,
      diagnostics: [],
    });
    const ctx = listCtx(() => {});
    const logs: string[] = [];
    ctx.log = (line) => logs.push(line);
    ctx.argv.flags.effective = false;
    ctx.argv.flags.configured = true;

    await runSkill(ctx, {
      registry: registry(),
      resolver: { resolve: async () => resolved },
    });

    expect(logs).toEqual(["project-review  [project/shadowed]  .agents/skills/review"]);
  });

  it("lists discovered candidates without resolving the effective catalog", async () => {
    const ctx = listCtx(() => {});
    const logs: string[] = [];
    ctx.log = (line) => logs.push(line);
    ctx.argv.flags.effective = false;
    ctx.argv.flags.discovered = true;

    await runSkill(ctx, {
      registry: registry(),
      resolver: {
        resolve: async () => {
          throw new Error("effective resolver must not run");
        },
      },
      discovery: {
        discover: async () => ({
          candidates: [
            {
              candidateId: "cand_test",
              id: "native-review",
              name: "native-review",
              description: "Native review",
              source: "codex-current",
              canonicalPath: "/repo/.agents/skills/native-review",
              context: { kind: "project", projectRoot: "/repo" },
              digest: "digest",
            },
          ],
          diagnostics: [],
          visitedDirectories: 1,
          truncated: false,
          timedOut: false,
        }),
        resolveCandidate: async () => {
          throw new Error("not used");
        },
      },
    });

    expect(logs).toEqual(["native-review  [codex-current]  /repo/.agents/skills/native-review"]);
  });

  it("suggest ranks the snapshot resolver's effective project catalog", async () => {
    const logs: string[] = [];
    const ctx = listCtx((line) => logs.push(line));
    ctx.argv.verb = "suggest";
    ctx.argv.flags = { project: PROJECT_ID, prompt: "project review" };
    const contexts: RuntimeContextRef[] = [];

    await runSkill(ctx, {
      registry: registry(),
      resolver: {
        resolve: async (context) => {
          contexts.push(context);
          return snapshot(context);
        },
      },
    });

    expect(contexts).toEqual([{ kind: "project", projectId: PROJECT_ID }]);
    expect(logs.join("\n")).toContain("project-review");
  });

  it("keeps --dir as an explicit compatibility override", async () => {
    const home = await mkdtemp(join(tmpdir(), "ratel-suggest-dir-"));
    try {
      const dir = join(home, "skills");
      await mkdir(join(dir, "legacy-review"), { recursive: true });
      await writeFile(
        join(dir, "legacy-review", "SKILL.md"),
        "---\nname: legacy-review\ndescription: Legacy review flow\n---\nreview instructions",
      );
      const logs: string[] = [];
      const ctx = listCtx((line) => logs.push(line));
      ctx.env = { homeDir: home };
      ctx.argv.verb = "suggest";
      ctx.argv.flags = { prompt: "legacy review", dir };

      await runSkill(ctx, {
        registry: registry(),
        resolver: {
          resolve: async () => {
            throw new Error("resolver must not run with --dir");
          },
        },
      });

      expect(logs.join("\n")).toContain("legacy-review");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
