import { describe, expect, it } from "vitest";
import type { ServerEntry } from "../lib/index.js";
import { ClaudeCodeAgentHostAdapter } from "./claude-code.js";
import type { AgentHostContext, AgentHostPlanInput, AgentScope } from "./index.js";

const HOME = "/home/u";
const ROOT = "/r";
const HOME_CLAUDE = "/home/u/.claude.json";
const PROJECT_MCP = "/r/.mcp.json";
const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";
const RATEL_LOCAL = "/r/.ratel/config.local.json";

const BIN = {
  command: "ratel-local",
  args: [],
  source: "path" as const,
};

const FS_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["fs"] };
const PROJ_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["proj"] };
const LOCAL_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["local"] };

function ctxOf(
  files: Record<string, string>,
  env: AgentHostContext["env"] = { homeDir: HOME, projectRoot: ROOT },
): AgentHostContext {
  return {
    env,
    fs: {
      read: async (path) => (Object.hasOwn(files, path) ? files[path] : null),
      writeAtomic: async () => {},
      exists: async (path) => Object.hasOwn(files, path),
    },
  };
}

function linkInput(
  state: Awaited<ReturnType<ClaudeCodeAgentHostAdapter["read"]>>,
  removeEntriesByScope: Map<AgentScope, Set<string>>,
): AgentHostPlanInput {
  return {
    state,
    bin: BIN,
    ratelConfigPaths: {
      user: RATEL_USER,
      project: RATEL_PROJECT,
      local: RATEL_LOCAL,
    },
    removeEntriesByScope,
  };
}

describe("ClaudeCodeAgentHostAdapter", () => {
  it("detects and reads user, project, and local Claude Code MCP entries", async () => {
    const adapter = new ClaudeCodeAgentHostAdapter();
    const ctx = ctxOf({
      [HOME_CLAUDE]: JSON.stringify({
        mcpServers: { fs: FS_ENTRY },
        projects: {
          [ROOT]: { mcpServers: { local: LOCAL_ENTRY } },
          "/elsewhere": { mcpServers: { other: { type: "stdio", command: "x" } } },
        },
      }),
      [PROJECT_MCP]: JSON.stringify({ mcpServers: { proj: PROJ_ENTRY } }),
    });

    const detection = await adapter.detect(ctx);
    const state = await adapter.read(ctx);

    expect(detection.present).toBe(true);
    expect(detection.reasons).toEqual([`Found ${HOME_CLAUDE}.`, `Found ${PROJECT_MCP}.`]);
    expect(state.host).toEqual({ kind: "claude-code", displayName: "Claude Code" });
    expect(state.scopes.find((scope) => scope.scope === "user")?.mcpServers).toEqual({
      fs: FS_ENTRY,
    });
    expect(state.scopes.find((scope) => scope.scope === "project")?.mcpServers).toEqual({
      proj: PROJ_ENTRY,
    });
    expect(state.scopes.find((scope) => scope.scope === "local")?.mcpServers).toEqual({
      local: LOCAL_ENTRY,
    });
  });

  it("reads only the user scope when no project root is available", async () => {
    const adapter = new ClaudeCodeAgentHostAdapter();
    const state = await adapter.read(
      ctxOf(
        {
          [HOME_CLAUDE]: JSON.stringify({ mcpServers: { fs: FS_ENTRY } }),
        },
        { homeDir: HOME },
      ),
    );

    expect(state.scopes.map((scope) => scope.scope)).toEqual(["user"]);
    expect(state.scopes[0].path).toBe(HOME_CLAUDE);
  });

  it("surfaces JSON parse errors with the Claude config path", async () => {
    const adapter = new ClaudeCodeAgentHostAdapter();

    await expect(adapter.read(ctxOf({ [HOME_CLAUDE]: "not json" }))).rejects.toThrow(
      /\/home\/u\/\.claude\.json/,
    );
  });

  it("rewrites user and local entries in one home config write", async () => {
    const adapter = new ClaudeCodeAgentHostAdapter();
    const ctx = ctxOf({
      [HOME_CLAUDE]: JSON.stringify({
        version: 7,
        mcpServers: {
          fs: FS_ENTRY,
          keep: { type: "stdio", command: "keep" },
          "ratel-local": {
            type: "stdio",
            command: "ratel-local",
            args: ["serve", "--config", "old"],
          },
        },
        projects: {
          [ROOT]: {
            mcpServers: {
              local: LOCAL_ENTRY,
              untouched: { type: "stdio", command: "untouched" },
            },
          },
          "/elsewhere": { mcpServers: { other: { type: "stdio", command: "x" } } },
        },
      }),
    });
    const state = await adapter.read(ctx);

    const changes = await adapter.planChanges(
      linkInput(
        state,
        new Map([
          ["user", new Set(["fs"])],
          ["local", new Set(["local"])],
        ]),
      ),
    );

    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0].path).toBe(HOME_CLAUDE);
    const after = JSON.parse(changes.changes[0].after);
    expect(after.version).toBe(7);
    expect(after.mcpServers.fs).toBeUndefined();
    expect(after.mcpServers.keep).toEqual({ type: "stdio", command: "keep" });
    expect(after.mcpServers["ratel-local"].args).toEqual(["serve", "--config", "old"]);
    expect(after.projects[ROOT].mcpServers.local).toBeUndefined();
    expect(after.projects[ROOT].mcpServers.untouched).toEqual({
      type: "stdio",
      command: "untouched",
    });
    expect(after.projects[ROOT].mcpServers["ratel-local"]).toBeUndefined();
    expect(after.projects["/elsewhere"]).toEqual({
      mcpServers: { other: { type: "stdio", command: "x" } },
    });
  });

  it("rewrites project entries with the user and project config chain", async () => {
    const adapter = new ClaudeCodeAgentHostAdapter();
    const ctx = ctxOf({
      [HOME_CLAUDE]: JSON.stringify({}),
      [PROJECT_MCP]: JSON.stringify({
        mcpServers: {
          proj: PROJ_ENTRY,
          keep: { type: "stdio", command: "keep" },
        },
      }),
    });
    const state = await adapter.read(ctx);

    const changes = await adapter.planChanges(
      linkInput(state, new Map([["project", new Set(["proj"])]])),
    );

    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0].path).toBe(PROJECT_MCP);
    const after = JSON.parse(changes.changes[0].after);
    expect(after.mcpServers.proj).toBeUndefined();
    expect(after.mcpServers.keep).toEqual({ type: "stdio", command: "keep" });
    expect(after.mcpServers["ratel-local"]).toBeUndefined();
  });
});
