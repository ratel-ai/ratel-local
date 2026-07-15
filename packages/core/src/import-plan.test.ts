import { describe, expect, it } from "vitest";
import type {
  AgentHostAdapter,
  AgentHostChangeSet,
  AgentHostContext,
  AgentHostDetection,
  AgentHostPlanInput,
  AgentHostState,
  AgentScope,
} from "./agent-host/index.js";
import {
  buildAgentImportPlan,
  buildImportPlan,
  type FileChange,
  type ImportInputs,
} from "./import-plan.js";
import type { ServerEntry } from "./lib/index.js";
import type { ResolvedBin } from "./locate-bin.js";

const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";
const RATEL_LOCAL = "/r/.ratel/config.local.json";

const BIN: ResolvedBin = {
  command: "ratel-mcp",
  args: [],
  source: "path",
};

const FS_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["fs"] };
const REMOTE_ENTRY: ServerEntry = { type: "http", url: "https://r" };
const PROJ_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["proj"] };
const LOCAL_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["local"] };

function agentState(
  scopes: Partial<Record<AgentScope, Record<string, ServerEntry>>>,
): AgentHostState {
  return {
    host: { kind: "test-agent", displayName: "Test Agent" },
    scopes: (["user", "project", "local"] as const).map((scope) => ({
      scope,
      displayName: scope,
      path: `/agent/${scope}.json`,
      available: true,
      mcpServers: scopes[scope] ?? {},
    })),
  };
}

function emptyInputs(overrides: Partial<ImportInputs> = {}): ImportInputs {
  return {
    agentState: agentState({}),
    ratelUser: null,
    ratelProject: null,
    ratelLocal: null,
    bin: BIN,
    ratelUserPath: RATEL_USER,
    ratelProjectPath: RATEL_PROJECT,
    ratelLocalPath: RATEL_LOCAL,
    ...overrides,
  };
}

function allChanges(plan: ReturnType<typeof buildImportPlan>) {
  return [...plan.ratelChanges, ...plan.agentChanges];
}

function findWrite(plan: ReturnType<typeof buildImportPlan>, path: string) {
  return allChanges(plan).find((c) => c.kind === "write" && c.path === path);
}

function parseAfter(plan: ReturnType<typeof buildImportPlan>, path: string) {
  const c = findWrite(plan, path);
  if (!c || c.kind !== "write") throw new Error(`no write to ${path}`);
  return JSON.parse(c.after);
}

class RecordingAgentHost implements AgentHostAdapter {
  input: AgentHostPlanInput | null = null;

  async detect(_ctx: AgentHostContext): Promise<AgentHostDetection> {
    return { displayName: "Test Agent", present: true, reasons: [], warnings: [] };
  }

  async read(_ctx: AgentHostContext): Promise<AgentHostState> {
    return agentState({});
  }

  async planChanges(input: AgentHostPlanInput): Promise<AgentHostChangeSet> {
    this.input = input;
    const changes: FileChange[] = [];
    for (const [scope, names] of input.removeEntriesByScope) {
      changes.push({
        kind: "write",
        path: `/agent/${scope}.json`,
        before: "{}\n",
        after: JSON.stringify({ replaced: [...names].sort() }),
      });
    }
    return {
      changes,
      summary: {
        host: input.state.host,
        installedGatewayScopes: [...input.removeEntriesByScope.keys()],
        removedNativeEntries: [],
        warnings: [],
      },
    };
  }
}

describe("buildImportPlan", () => {
  it("user-only: moves entries into Ratel user config and records gateway args", () => {
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY, remote: REMOTE_ENTRY } }),
      }),
    );

    expect(plan.summary.movedFromUser.sort()).toEqual(["fs", "remote"]);
    expect(plan.summary.ratelEntryArgsByScope.user).toEqual(["--config", RATEL_USER]);
    expect(plan.summary.ratelEntryArgsByScope.project).toBeUndefined();
    expect(plan.summary.ratelEntryArgsByScope.local).toBeUndefined();

    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelUser.mcpServers.remote).toEqual(REMOTE_ENTRY);
    expect(plan.agentChanges).toEqual([]);
  });

  it("project entries use the user+project config chain", () => {
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY }, project: { proj: PROJ_ENTRY } }),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.project).toEqual([
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("local entries use all three configs", () => {
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({
          user: { fs: FS_ENTRY },
          project: { proj: PROJ_ENTRY },
          local: { local: LOCAL_ENTRY },
        }),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.local).toEqual([
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);
  });

  it("local-only: writes only the local Ratel target", () => {
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ local: { local: LOCAL_ENTRY } }),
      }),
    );

    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
    expect(findWrite(plan, RATEL_PROJECT)).toBeUndefined();
    expect(findWrite(plan, RATEL_LOCAL)).toBeDefined();
  });

  it("skips Ratel gateway entries at every scope", () => {
    const ratelStub: ServerEntry = {
      type: "stdio",
      command: "ratel-mcp",
      args: ["serve", "--config", RATEL_USER],
    };
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({
          user: { "ratel-mcp": ratelStub },
          project: { "ratel-mcp": ratelStub },
          local: { "ratel-mcp": ratelStub },
        }),
      }),
    );

    expect(plan.summary.movedFromUser).toEqual([]);
    expect(plan.summary.movedFromProject).toEqual([]);
    expect(plan.summary.movedFromLocal).toEqual([]);
    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
  });

  it("keeps Ratel entries on conflicts by default and exposes structured conflict data", () => {
    const existingRatelEntry: ServerEntry = { type: "stdio", command: "kept" };
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY, other: REMOTE_ENTRY } }),
        ratelUser: { mcpServers: { fs: existingRatelEntry } },
      }),
    );

    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(existingRatelEntry);
    expect(ratelUser.mcpServers.other).toEqual(REMOTE_ENTRY);
    expect(plan.summary.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fs", scope: "user" })]),
    );
    expect(plan.summary.conflicts).toEqual([
      { name: "fs", scope: "user", incoming: FS_ENTRY, existing: existingRatelEntry },
    ]);
  });

  it("does not prompt a conflict when the existing Ratel entry is equivalent to the agent entry", async () => {
    const incoming = {
      command: "echo",
      args: ["fs"],
      env: { B: "2", A: "1" },
    } as ServerEntry;
    const existingRatelEntry: ServerEntry = {
      type: "stdio",
      env: { A: "1", B: "2" },
      args: ["fs"],
      command: "echo",
    };
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ user: { fs: incoming } }),
        ratelUser: { mcpServers: { fs: existingRatelEntry } },
      }),
    );

    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
    expect(plan.summary.conflicts).toEqual([]);
    expect(plan.summary.skipped).toEqual([]);
    expect(plan.summary.movedFromUser).toEqual(["fs"]);
    expect(plan.summary.replacedFromUser).toEqual(["fs"]);

    const agentHost = new RecordingAgentHost();
    const agentPlan = await buildAgentImportPlan({
      ...emptyInputs({
        agentState: agentState({ user: { fs: incoming } }),
        ratelUser: { mcpServers: { fs: existingRatelEntry } },
      }),
      agentHost,
    });
    expect(agentHost.input?.removeEntriesByScope.get("user")).toEqual(new Set(["fs"]));
    expect(agentPlan.agentChanges).toHaveLength(1);
  });

  it("replaces Ratel entries on conflicts when requested", () => {
    const existingRatelEntry: ServerEntry = { type: "stdio", command: "kept" };
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY, other: REMOTE_ENTRY } }),
        ratelUser: { mcpServers: { fs: existingRatelEntry } },
      }),
      { conflictStrategy: "replace-from-agent" },
    );

    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelUser.mcpServers.other).toEqual(REMOTE_ENTRY);
  });

  it("dedups across scopes: most-specific wins", () => {
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY }, project: { fs: PROJ_ENTRY } }),
      }),
    );
    const ratelProject = parseAfter(plan, RATEL_PROJECT);
    expect(ratelProject.mcpServers.fs).toEqual(PROJ_ENTRY);
    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
    expect(plan.summary.movedFromProject).toEqual(["fs"]);
    expect(plan.summary.movedFromUser).toEqual([]);
  });

  it("filters movable entries by selection", () => {
    const plan = buildImportPlan(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY, remote: REMOTE_ENTRY } }),
      }),
      { selection: new Set(["fs"]) },
    );

    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelUser.mcpServers.remote).toBeUndefined();
    expect(plan.summary.movedFromUser).toEqual(["fs"]);
  });

  it("delegates native rewrites to the selected agent adapter", async () => {
    const agentHost = new RecordingAgentHost();
    const plan = await buildAgentImportPlan(
      { ...emptyInputs({ agentState: agentState({ user: { fs: FS_ENTRY } }) }), agentHost },
      { selection: new Set(["fs"]) },
    );

    expect(agentHost.input?.removeEntriesByScope.get("user")).toEqual(new Set(["fs"]));
    expect(plan.agentChanges).toEqual([
      { kind: "write", path: "/agent/user.json", before: "{}\n", after: '{"replaced":["fs"]}' },
    ]);
  });
});
