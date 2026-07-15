import { describe, expect, it } from "vitest";
import {
  agentKindToSkillSource,
  applySkillImportSelections,
  availableSkillImportScopes,
  availableSkillsForKind,
  buildSkillImportSelections,
  configuredSkillRegistrationGroups,
  discoveredSkillSummaries,
  effectiveSkillSummaries,
  type SkillSummary,
} from "./skills";

describe("agentKindToSkillSource", () => {
  it("maps claude-code to the claude skill source", () => {
    expect(agentKindToSkillSource("claude-code")).toBe("claude");
  });

  it("maps codex to the codex skill source", () => {
    expect(agentKindToSkillSource("codex")).toBe("codex");
  });
});

describe("scoped skill response", () => {
  it("uses resolver effective registrations and opaque discovery candidates", () => {
    const response = {
      managedDir: "",
      nativeDir: "",
      codexDir: "",
      managed: [],
      available: [],
      problems: [],
      effectiveSkills: [
        { id: "audit", name: "Audit", description: "Project audit", tags: ["review"] },
      ],
      registrations: [
        {
          id: "audit",
          source: "codex",
          scopeRef: { scope: "project" as const, projectId: "prj_1" },
          ref: {
            scopeRef: { scope: "project" as const, projectId: "prj_1" },
            id: "audit",
            kind: "entry" as const,
            configuredPath: ".agents/skills/audit",
          },
          mode: "reference" as const,
          state: "effective" as const,
          editable: false,
        },
      ],
      discovered: [
        { id: "audit", source: "codex-current", candidateId: "candidate_configured" },
        { id: "new", source: "claude", candidateId: "candidate_new" },
      ],
    };

    expect(effectiveSkillSummaries(response)).toEqual([
      expect.objectContaining({
        id: "audit",
        source: "codex",
        registration: expect.objectContaining({
          scopeRef: { scope: "project", projectId: "prj_1" },
        }),
      }),
    ]);
    expect(discoveredSkillSummaries(response)).toEqual([
      expect.objectContaining({ id: "new", source: "claude", candidateId: "candidate_new" }),
    ]);
  });

  it("groups every configured registration state by project scope", () => {
    const response = {
      managedDir: "",
      nativeDir: "",
      codexDir: "",
      managed: [],
      available: [],
      problems: [],
      registrations: [
        {
          id: "shared",
          source: "claude",
          scopeRef: { scope: "user" as const },
          ref: {
            scopeRef: { scope: "user" as const },
            id: "shared",
            kind: "entry" as const,
            configuredPath: "/home/u/.claude/skills/shared",
          },
          mode: "reference" as const,
          state: "shadowed" as const,
          editable: false,
        },
        {
          id: "shared",
          source: "claude",
          scopeRef: { scope: "project" as const, projectId: "prj_1" },
          ref: {
            scopeRef: { scope: "project" as const, projectId: "prj_1" },
            id: "shared",
            kind: "entry" as const,
            configuredPath: "shared",
          },
          mode: "copy" as const,
          state: "effective" as const,
          editable: true,
        },
        {
          id: "broken",
          source: "unknown",
          scopeRef: { scope: "local" as const, projectId: "prj_1" },
          ref: {
            scopeRef: { scope: "local" as const, projectId: "prj_1" },
            id: "broken",
            kind: "entry" as const,
            configuredPath: "missing",
          },
          mode: "reference" as const,
          state: "invalid" as const,
          editable: false,
        },
      ],
    };

    expect(
      configuredSkillRegistrationGroups(response, { kind: "project", projectId: "prj_1" }),
    ).toEqual([
      {
        scope: "user",
        registrations: [expect.objectContaining({ id: "shared", state: "shadowed" })],
      },
      {
        scope: "project",
        registrations: [expect.objectContaining({ id: "shared", state: "effective" })],
      },
      {
        scope: "local",
        registrations: [expect.objectContaining({ id: "broken", state: "invalid" })],
      },
    ]);
  });
});

describe("availableSkillsForKind", () => {
  const skill = (id: string, source: SkillSummary["source"]): SkillSummary => ({
    id,
    name: id,
    description: "",
    tags: [],
    source,
  });
  const available: SkillSummary[] = [
    skill("a", "claude"),
    skill("b", "codex"),
    skill("c", "claude"),
  ];

  it("returns only the agent's own unmanaged skills", () => {
    expect(availableSkillsForKind(available, "claude-code").map((s) => s.id)).toEqual(["a", "c"]);
    expect(availableSkillsForKind(available, "codex").map((s) => s.id)).toEqual(["b"]);
  });
});

describe("scoped skill import", () => {
  it("builds discriminated targets from the selected URL context", () => {
    const selected: SkillSummary[] = [
      {
        id: "review",
        name: "review",
        description: "",
        tags: [],
        source: "codex",
        candidateId: "candidate_review",
      },
    ];

    expect(availableSkillImportScopes({ kind: "global" })).toEqual(["user"]);
    expect(availableSkillImportScopes({ kind: "project", projectId: "prj_1" })).toEqual([
      "user",
      "project",
      "local",
    ]);
    expect(availableSkillImportScopes({ kind: "all" })).toEqual([]);
    expect(
      buildSkillImportSelections(
        selected,
        { kind: "project", projectId: "prj_1" },
        {
          scope: "local",
          mode: "copy",
        },
      ),
    ).toEqual([
      {
        candidateId: "candidate_review",
        targets: [{ scopeRef: { scope: "local", projectId: "prj_1" }, mode: "copy" }],
      },
    ]);
  });

  it("previews and applies opaque candidates through the current import endpoints", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const request = async <T>(path: string, init?: { body?: unknown }): Promise<T> => {
      calls.push({ path, body: init?.body });
      if (path.endsWith("/preview")) {
        return { id: "plan_1", digest: "digest_1", operations: [] } as T;
      }
      return { transactionId: "tx_1" } as T;
    };
    const selections = [
      {
        candidateId: "candidate_review",
        targets: [{ scopeRef: { scope: "user" as const }, mode: "reference" as const }],
      },
    ];

    await applySkillImportSelections(request, selections);

    expect(calls).toEqual([
      {
        path: "/api/skills/import/preview",
        body: { selections },
      },
      {
        path: "/api/skills/import/apply",
        body: {
          plan: { id: "plan_1", digest: "digest_1", operations: [] },
          digest: "digest_1",
        },
      },
    ]);
  });
});
