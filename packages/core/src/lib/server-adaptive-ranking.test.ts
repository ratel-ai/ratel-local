import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IntentGraph, SkillCatalog, ToolCatalog } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";

const BUILD_QUERY = "why is the build broken";
const FILE_QUERY = "read a file from disk";

function learnedCapabilities(graph: IntentGraph, query: string): string[] {
  const wire = JSON.parse(graph.toJson()) as {
    intents: { members: string[]; tools: Record<string, number>; skills: Record<string, number> }[];
  };
  const intent = wire.intents.find((intent) => intent.members.includes(query));
  return [...Object.keys(intent?.tools ?? {}), ...Object.keys(intent?.skills ?? {})];
}

async function connect(catalog: ToolCatalog, skillCatalog: SkillCatalog) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const handle = await createMcpServer(catalog, {
    name: "adaptive-test",
    version: "1.0.0",
    transport: serverTransport,
    skillCatalog,
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
  const catalog = new ToolCatalog();
  const skills = new SkillCatalog();
  await catalog.register([
    {
      id: "build_status",
      name: "build_status",
      description: "Inspect build status",
      inputSchema: {},
      outputSchema: {},
      execute: () => ({ ok: true }),
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
  return { graph, catalog, skills };
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
