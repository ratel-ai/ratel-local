import { describe, expect, it } from "vitest";
import { ClaudeCodeAgentHostAdapter } from "./agent-host/claude-code.js";
import { CodexAgentHostAdapter, parseCodexMcpServers } from "./agent-host/codex.js";
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
  buildAgentAgentImportDraft,
  buildAgentImportDraft,
  buildAgentLinkPlan,
  type ImportInputs,
  type PlannedFileWrite,
} from "./import-plan.js";
import type { ServerEntry } from "./lib/index.js";
import type { ResolvedBin } from "./locate-bin.js";

const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";
const RATEL_LOCAL = "/r/.ratel/config.local.json";

const BIN: ResolvedBin = {
  command: "ratel-local",
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

function allChanges(plan: ReturnType<typeof buildAgentImportDraft>) {
  return [...plan.ratelChanges, ...plan.agentChanges];
}

function findWrite(plan: ReturnType<typeof buildAgentImportDraft>, path: string) {
  return allChanges(plan).find((c) => c.kind === "write" && c.path === path);
}

function parseAfter(plan: ReturnType<typeof buildAgentImportDraft>, path: string) {
  const c = findWrite(plan, path);
  if (!c || c.kind !== "write") throw new Error(`no write to ${path}`);
  return JSON.parse(c.after);
}

class RecordingAgentHost implements AgentHostAdapter {
  input: AgentHostPlanInput | null = null;

  constructor(readonly supportedScopes: readonly AgentScope[] = ["user", "project", "local"]) {}

  async detect(_ctx: AgentHostContext): Promise<AgentHostDetection> {
    return { displayName: "Test Agent", present: true, reasons: [], warnings: [] };
  }

  async read(_ctx: AgentHostContext): Promise<AgentHostState> {
    return agentState({});
  }

  async planChanges(input: AgentHostPlanInput): Promise<AgentHostChangeSet> {
    this.input = input;
    const changes: PlannedFileWrite[] = [];
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

describe("buildAgentImportDraft", () => {
  it("user-only: moves entries into Ratel user config and records gateway args", () => {
    const plan = buildAgentImportDraft(
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

  it("preserves skills while importing MCP entries into the same scope", () => {
    const plan = buildAgentImportDraft(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY } }),
        ratelUser: {
          mcpServers: {},
          skills: { entries: { review: { mode: "reference", path: "/skills/review" } } },
        },
      }),
    );

    expect(parseAfter(plan, RATEL_USER)).toEqual({
      mcpServers: { fs: FS_ENTRY },
      skills: { entries: { review: { mode: "reference", path: "/skills/review" } } },
    });
  });

  it("project entries use the user+project config chain", () => {
    const plan = buildAgentImportDraft(
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
    const plan = buildAgentImportDraft(
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
    const plan = buildAgentImportDraft(
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
      command: "ratel-local",
      args: ["serve", "--config", RATEL_USER],
    };
    const plan = buildAgentImportDraft(
      emptyInputs({
        agentState: agentState({
          user: { "ratel-local": ratelStub },
          project: { "ratel-local": ratelStub },
          local: { "ratel-local": ratelStub },
        }),
      }),
    );

    expect(plan.summary.movedFromUser).toEqual([]);
    expect(plan.summary.movedFromProject).toEqual([]);
    expect(plan.summary.movedFromLocal).toEqual([]);
    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
  });

  it("skips legacy ratel-mcp gateway entries during migration", () => {
    const legacyGateway: ServerEntry = {
      type: "stdio",
      command: "ratel-mcp",
      args: ["serve", "--config", RATEL_USER],
    };
    const plan = buildAgentImportDraft(
      emptyInputs({
        agentState: agentState({ user: { "ratel-mcp": legacyGateway } }),
      }),
    );

    expect(plan.summary.movedFromUser).toEqual([]);
    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
  });

  it("keeps Ratel entries on conflicts by default and exposes structured conflict data", () => {
    const existingRatelEntry: ServerEntry = { type: "stdio", command: "kept" };
    const plan = buildAgentImportDraft(
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
    const plan = buildAgentImportDraft(
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
    const agentPlan = await buildAgentAgentImportDraft({
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
    const plan = buildAgentImportDraft(
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

  it("preserves same-name registrations at user and project scopes", () => {
    const plan = buildAgentImportDraft(
      emptyInputs({
        agentState: agentState({ user: { fs: FS_ENTRY }, project: { fs: PROJ_ENTRY } }),
      }),
    );
    const ratelUser = parseAfter(plan, RATEL_USER);
    const ratelProject = parseAfter(plan, RATEL_PROJECT);
    expect(ratelUser.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelProject.mcpServers.fs).toEqual(PROJ_ENTRY);
    expect(plan.summary.movedFromProject).toEqual(["fs"]);
    expect(plan.summary.movedFromUser).toEqual(["fs"]);
    expect(plan.summary.skipped).toEqual([]);
  });

  it("filters movable entries by selection", () => {
    const plan = buildAgentImportDraft(
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
    const plan = await buildAgentAgentImportDraft(
      { ...emptyInputs({ agentState: agentState({ user: { fs: FS_ENTRY } }) }), agentHost },
      { selection: new Set(["fs"]) },
    );

    expect(agentHost.input?.removeEntriesByScope.get("user")).toEqual(new Set(["fs"]));
    expect(plan.agentChanges).toEqual([
      { kind: "write", path: "/agent/user.json", before: "{}\n", after: '{"replaced":["fs"]}' },
    ]);
  });

  it("migrates a legacy Claude gateway when importing a native entry", async () => {
    const legacyGateway: ServerEntry = {
      type: "stdio",
      command: "ratel-mcp",
      args: ["serve", "--config", RATEL_USER],
    };
    const raw = { mcpServers: { "ratel-mcp": legacyGateway, fs: FS_ENTRY } };
    const state: AgentHostState = {
      host: { kind: "claude-code", displayName: "Claude Code" },
      scopes: [
        {
          scope: "user",
          displayName: "User",
          path: "/home/u/.claude.json",
          available: true,
          mcpServers: raw.mcpServers,
          raw,
        },
      ],
    };

    const plan = await buildAgentAgentImportDraft(
      {
        ...emptyInputs({ agentState: state }),
        agentHost: new ClaudeCodeAgentHostAdapter(),
        agentState: state,
      },
      { selection: new Set(["fs"]) },
    );

    expect(plan.agentChanges).toHaveLength(1);
    const change = plan.agentChanges[0];
    if (change.kind !== "write") throw new Error("expected a Claude config write");
    const after = JSON.parse(change.after);
    expect(after.mcpServers).toEqual({
      "ratel-local": {
        type: "stdio",
        command: "ratel-local",
        args: ["connect", "--agent-host", "claude-code", "--link-scope", "user"],
      },
    });
  });

  it("migrates a legacy Codex gateway when importing a native entry", async () => {
    const legacyGateway: ServerEntry = {
      type: "stdio",
      command: "ratel-mcp",
      args: ["serve", "--config", RATEL_USER],
    };
    const rawText = `[mcp_servers.ratel-mcp]
command = "ratel-mcp"
args = ["serve", "--config", "${RATEL_USER}"]

[mcp_servers.fs]
command = "echo"
args = ["fs"]
`;
    const state: AgentHostState = {
      host: { kind: "codex", displayName: "Codex" },
      scopes: [
        {
          scope: "user",
          displayName: "User",
          path: "/home/u/.codex/config.toml",
          available: true,
          mcpServers: { "ratel-mcp": legacyGateway, fs: FS_ENTRY },
          rawText,
        },
      ],
    };

    const plan = await buildAgentAgentImportDraft(
      {
        ...emptyInputs({ agentState: state }),
        agentHost: new CodexAgentHostAdapter(),
        agentState: state,
      },
      { selection: new Set(["fs"]) },
    );

    expect(plan.agentChanges).toHaveLength(1);
    const change = plan.agentChanges[0];
    if (change.kind !== "write") throw new Error("expected a Codex config write");
    expect(parseCodexMcpServers(change.after)).toEqual({
      "ratel-local": {
        type: "stdio",
        command: "ratel-local",
        args: ["connect", "--agent-host", "codex", "--link-scope", "user"],
        env: undefined,
      },
    });
  });

  it("links only scopes declared by the selected agent adapter", async () => {
    const agentHost = new RecordingAgentHost(["user", "project"]);

    await buildAgentLinkPlan({
      ...emptyInputs({
        ratelUser: { mcpServers: { user: FS_ENTRY } },
        ratelProject: { mcpServers: { project: PROJ_ENTRY } },
        ratelLocal: { mcpServers: { local: LOCAL_ENTRY } },
      }),
      agentHost,
    });

    expect(agentHost.input?.installGatewayScopes).toEqual(new Set(["user", "project"]));
  });

  it("links a scope whose Ratel document contains only skills", async () => {
    const agentHost = new RecordingAgentHost();

    await buildAgentLinkPlan({
      ...emptyInputs({
        ratelUser: {
          mcpServers: {},
          skills: { entries: { review: { mode: "reference", path: "/skills/review" } } },
        },
      }),
      agentHost,
    });

    expect(agentHost.input?.installGatewayScopes).toEqual(new Set(["user"]));
  });

  it("links project and local scopes that contain only retrieval overrides", async () => {
    const agentHost = new RecordingAgentHost();

    await buildAgentLinkPlan({
      ...emptyInputs({
        ratelUser: { mcpServers: { user: FS_ENTRY } },
        ratelProject: { mcpServers: {}, retrieval: { method: "semantic" } },
        ratelLocal: { mcpServers: {}, retrieval: { method: "bm25" } },
      }),
      agentHost,
    });

    expect(agentHost.input?.installGatewayScopes).toEqual(new Set(["user", "project", "local"]));
  });
});
