import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IntentGraph, SkillCatalog, ToolCatalog } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";
import { turnCorrelationKey } from "./turn-correlation.js";

const BUILD_QUERY = "why is the build broken";
const FILE_QUERY = "read a file from disk";

function learnedCapabilities(graph: IntentGraph, query: string): string[] {
  const wire = JSON.parse(graph.toJson()) as {
    intents: { members: string[]; tools: Record<string, number>; skills: Record<string, number> }[];
  };
  const intent = wire.intents.find((intent) => intent.members.includes(query));
  return [...Object.keys(intent?.tools ?? {}), ...Object.keys(intent?.skills ?? {})];
}

async function connect(
  catalog: ToolCatalog,
  skillCatalog: SkillCatalog,
  options: { perTurnCorrelation?: boolean } = {},
) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const handle = await createMcpServer(catalog, {
    name: "adaptive-test",
    version: "1.0.0",
    transport: serverTransport,
    skillCatalog,
    ...options,
  });
  const client = new Client({ name: "same-client-name", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

async function catalogs() {
  const graph = new IntentGraph();
  const upstreamArgs: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const trace = {
    kind: "callback" as const,
    sessionId: "test",
    onEvent: (l: string) => lines.push(l),
  };
  const catalog = new ToolCatalog({ trace });
  const skills = new SkillCatalog({ trace });
  // The callback sink delivers asynchronously; let queued lines land first.
  const events = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return lines.map((line) => JSON.parse(line) as { type: string; turn_id?: string });
  };
  await catalog.register([
    {
      id: "build_status",
      name: "build_status",
      description: "Inspect build status",
      inputSchema: {},
      outputSchema: {},
      execute: (args: Record<string, unknown>) => {
        upstreamArgs.push(args);
        return { ok: true };
      },
    },
    {
      id: "read_file",
      name: "read_file",
      description: "Read a file from disk",
      inputSchema: {},
      outputSchema: {},
      execute: () => ({ ok: true }),
    },
  ]);
  await skills.register([
    {
      id: "ci-triage",
      name: "ci-triage",
      description: "Diagnose a broken build",
      body: "# Diagnose CI",
    },
    {
      id: "file-guide",
      name: "file-guide",
      description: "Read files from disk",
      body: "# Read files",
    },
  ]);
  catalog.experimentalEnableAdaptiveRanking(graph);
  skills.experimentalEnableAdaptiveRanking(graph);
  return { graph, catalog, skills, upstreamArgs, events };
}

describe("MCP adaptive ranking session isolation", () => {
  for (const kind of ["tools", "skills", "mixed"] as const) {
    it(`pairs interleaved ${kind} invocations with each client's own search`, async () => {
      const { graph, catalog, skills } = await catalogs();
      const a = await connect(catalog, skills);
      const b = await connect(catalog, skills);
      try {
        await a.client.callTool({ name: "search_capabilities", arguments: { query: BUILD_QUERY } });
        await b.client.callTool({ name: "search_capabilities", arguments: { query: FILE_QUERY } });
        const aSkill = kind === "skills";
        const bSkill = kind !== "tools";
        await a.client.callTool(
          aSkill
            ? { name: "get_skill_content", arguments: { skillId: "ci-triage" } }
            : { name: "invoke_tool", arguments: { toolId: "build_status", args: {} } },
        );
        await b.client.callTool(
          bSkill
            ? { name: "get_skill_content", arguments: { skillId: "file-guide" } }
            : { name: "invoke_tool", arguments: { toolId: "read_file", args: {} } },
        );
        expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual([
          aSkill ? "ci-triage" : "build_status",
        ]);
        expect(learnedCapabilities(graph, FILE_QUERY)).toEqual([
          bSkill ? "file-guide" : "read_file",
        ]);
      } finally {
        await a.close();
        await b.close();
      }
    });
  }

  it("credits an invoke to the earlier of two searches when only that one offered it", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills);
    try {
      await a.client.callTool({ name: "search_capabilities", arguments: { query: BUILD_QUERY } });
      await a.client.callTool({ name: "search_capabilities", arguments: { query: FILE_QUERY } });
      await a.client.callTool({
        name: "invoke_tool",
        arguments: { toolId: "build_status", args: {} },
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual(["build_status"]);
      expect(learnedCapabilities(graph, FILE_QUERY)).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("does not let a new connection consume a disconnected client's pending search", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills);
    try {
      await a.client.callTool({ name: "search_capabilities", arguments: { query: BUILD_QUERY } });
    } finally {
      await a.close();
    }
    const b = await connect(catalog, skills);
    try {
      await b.client.callTool({
        name: "invoke_tool",
        arguments: { toolId: "build_status", args: {} },
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual([]);
      await b.client.callTool({ name: "search_capabilities", arguments: { query: FILE_QUERY } });
      await b.client.callTool({
        name: "invoke_tool",
        arguments: { toolId: "read_file", args: {} },
      });
      expect(learnedCapabilities(graph, FILE_QUERY)).toEqual(["read_file"]);
    } finally {
      await b.close();
    }
  });
});

const SESSION = "ea34d2b8-84f8-4023-a09e-f6b6ba4db6fb";
const TURN_1 = "b08207f6-4fc6-472b-822b-2008a0d6e424";
const TURN_2 = "63114747-af80-41b5-947e-02a73d7196b2";

function correlated(
  args: Record<string, unknown>,
  turn: string,
  extra: { session?: string; agent?: string } = {},
) {
  const { session = SESSION, agent } = extra;
  return { ...args, _ratel: { session, turn, ...(agent ? { agent } : {}) } };
}

describe("MCP adaptive ranking per-turn correlation", () => {
  it("pairs a search and an invoke from the same host turn across connections", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills, { perTurnCorrelation: true });
    const b = await connect(catalog, skills, { perTurnCorrelation: true });
    try {
      await a.client.callTool({
        name: "search_capabilities",
        arguments: correlated({ query: BUILD_QUERY }, TURN_1),
      });
      // A reconnect mid-turn keeps the host's ids, so the turn still pairs.
      await b.client.callTool({
        name: "invoke_tool",
        arguments: correlated({ toolId: "build_status", args: {} }, TURN_1),
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual(["build_status"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("does not pair a search from one turn with an invoke from a later turn", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills, { perTurnCorrelation: true });
    try {
      await a.client.callTool({
        name: "search_capabilities",
        arguments: correlated({ query: BUILD_QUERY }, TURN_1),
      });
      await a.client.callTool({
        name: "invoke_tool",
        arguments: correlated({ toolId: "build_status", args: {} }, TURN_2),
      });
      await a.client.callTool({
        name: "get_skill_content",
        arguments: correlated({ skillId: "ci-triage" }, TURN_2),
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("keeps a subagent's search apart from the parent's invoke in the same turn", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills, { perTurnCorrelation: true });
    try {
      await a.client.callTool({
        name: "search_capabilities",
        arguments: correlated({ query: BUILD_QUERY }, TURN_1, { agent: "sub-1" }),
      });
      await a.client.callTool({
        name: "invoke_tool",
        arguments: correlated({ toolId: "build_status", args: {} }, TURN_1),
      });
      await a.client.callTool({
        name: "invoke_tool",
        arguments: correlated({ toolId: "build_status", args: {} }, TURN_1, { agent: "sub-2" }),
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual([]);

      await a.client.callTool({
        name: "get_skill_content",
        arguments: correlated({ skillId: "ci-triage" }, TURN_1, { agent: "sub-1" }),
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual(["ci-triage"]);
    } finally {
      await a.close();
    }
  });

  it("keeps per-connection pairing when the field is absent", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills, { perTurnCorrelation: true });
    const b = await connect(catalog, skills, { perTurnCorrelation: true });
    try {
      await a.client.callTool({ name: "search_capabilities", arguments: { query: BUILD_QUERY } });
      await b.client.callTool({
        name: "invoke_tool",
        arguments: { toolId: "build_status", args: {} },
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual([]);
      await a.client.callTool({
        name: "invoke_tool",
        arguments: { toolId: "build_status", args: {} },
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual(["build_status"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("falls back to per-connection pairing when the field is malformed", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills, { perTurnCorrelation: true });
    try {
      await a.client.callTool({
        name: "search_capabilities",
        arguments: { query: BUILD_QUERY, _ratel: { session: SESSION } },
      });
      await a.client.callTool({
        name: "invoke_tool",
        arguments: { toolId: "build_status", args: {}, _ratel: "garbage" },
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual(["build_status"]);
    } finally {
      await a.close();
    }
  });

  it("ignores the field for pairing when the flag is off", async () => {
    const { graph, catalog, skills } = await catalogs();
    const a = await connect(catalog, skills);
    const b = await connect(catalog, skills);
    try {
      await a.client.callTool({
        name: "search_capabilities",
        arguments: correlated({ query: BUILD_QUERY }, TURN_1),
      });
      await b.client.callTool({
        name: "invoke_tool",
        arguments: correlated({ toolId: "build_status", args: {} }, TURN_1),
      });
      expect(learnedCapabilities(graph, BUILD_QUERY)).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  for (const perTurnCorrelation of [false, true]) {
    it(`never forwards the field upstream (flag ${perTurnCorrelation ? "on" : "off"})`, async () => {
      const { catalog, skills, upstreamArgs } = await catalogs();
      const a = await connect(catalog, skills, { perTurnCorrelation });
      try {
        const nested = await a.client.callTool({
          name: "invoke_tool",
          arguments: correlated({ toolId: "build_status", args: { verbose: true } }, TURN_1),
        });
        // A flattened call (no `args`) treats the remaining top-level keys as the
        // tool's arguments, so the field must be gone before the SDK sees it.
        const flattened = await a.client.callTool({
          name: "invoke_tool",
          arguments: correlated({ toolId: "build_status", verbose: true }, TURN_1),
        });
        const malformed = await a.client.callTool({
          name: "invoke_tool",
          arguments: { toolId: "build_status", verbose: true, _ratel: "garbage" },
        });
        expect([nested.isError, flattened.isError, malformed.isError]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
        expect(upstreamArgs).toEqual([{ verbose: true }, { verbose: true }, { verbose: true }]);
      } finally {
        await a.close();
      }
    });
  }

  it("opens one SDK turn per host turn and stamps every event in it", async () => {
    const { catalog, skills, events } = await catalogs();
    const a = await connect(catalog, skills, { perTurnCorrelation: true });
    const b = await connect(catalog, skills, { perTurnCorrelation: true });
    try {
      await a.client.callTool({
        name: "search_capabilities",
        arguments: correlated({ query: BUILD_QUERY }, TURN_1),
      });
      await b.client.callTool({
        name: "invoke_tool",
        arguments: correlated({ toolId: "no_such_tool", args: {} }, TURN_1),
      });
      await a.client.callTool({
        name: "get_skill_content",
        arguments: correlated({ skillId: "ci-triage" }, TURN_2),
      });
      const turn1 = turnCorrelationKey({ session: SESSION, turn: TURN_1 });
      const turn2 = turnCorrelationKey({ session: SESSION, turn: TURN_2 });
      const seen = await events();
      expect(seen.filter((e) => e.type === "turn_start").map((e) => e.turn_id)).toEqual([
        turn1,
        turn2,
      ]);
      expect(seen.find((e) => e.type === "gateway_error")?.turn_id).toBe(turn1);
      expect(seen.find((e) => e.type === "skill_invoke")?.turn_id).toBe(turn2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  for (const perTurnCorrelation of [false, true]) {
    it(`opens no SDK turn for per-connection pairing (flag ${perTurnCorrelation ? "on" : "off"})`, async () => {
      const { catalog, skills, events } = await catalogs();
      const a = await connect(catalog, skills, { perTurnCorrelation });
      try {
        await a.client.callTool({
          name: "search_capabilities",
          arguments: perTurnCorrelation
            ? { query: BUILD_QUERY }
            : correlated({ query: BUILD_QUERY }, TURN_1),
        });
        const seen = await events();
        expect(seen.filter((e) => e.type === "turn_start")).toEqual([]);
        const search = seen.find((e) => e.type === "search");
        expect(search?.turn_id).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        await a.close();
      }
    });
  }

  it("does not declare the field in any gateway tool's input schema", async () => {
    const { catalog, skills } = await catalogs();
    const a = await connect(catalog, skills, { perTurnCorrelation: true });
    try {
      const { tools } = await a.client.listTools();
      for (const tool of tools) {
        expect(JSON.stringify(tool.inputSchema)).not.toContain("_ratel");
      }
    } finally {
      await a.close();
    }
  });
});
