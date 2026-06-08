import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayFromConfig } from "../gateway.js";
import { createMcpServer } from "../server.js";

let root: string;
let telemetryFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ratel-skills-e2e-"));
  telemetryFile = join(root, "telemetry.jsonl");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("skills end-to-end via the gateway", () => {
  it("loads a skill from disk, ranks it, dispatches its body, and records telemetry", async () => {
    const skillsDir = join(root, "skills");
    const skillDir = join(skillsDir, "api-design");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: api-design\ndescription: REST API design patterns — resource naming, status codes, pagination.\ntags: [backend, api]\n---\n\n# API Design\n\nUse nouns for resources; return 201 on create.`,
    );

    const gateway = await buildGatewayFromConfig(
      { mcpServers: {} },
      {
        skillDirs: [skillsDir],
        trace: { kind: "jsonl", sessionId: "e2e", path: telemetryFile },
        logger: () => {},
      },
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const exposed = await createMcpServer(gateway.catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      skillCatalog: gateway.skillCatalog,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    // The two skill gateway tools are exposed.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("search_skills");
    expect(tools.map((t) => t.name)).toContain("invoke_skill");

    // search_skills ranks the disk-loaded skill.
    const found = await client.callTool({
      name: "search_skills",
      arguments: { query: "design a REST endpoint with pagination" },
    });
    const hits = (found.structuredContent as { skills: Array<{ skillId: string }> }).skills;
    expect(hits[0]?.skillId).toBe("api-design");

    // invoke_skill returns the body (with bundled-resource footer absent here).
    const loaded = await client.callTool({
      name: "invoke_skill",
      arguments: { skillId: "api-design" },
    });
    expect((loaded.structuredContent as { body: string }).body).toContain(
      "Use nouns for resources",
    );

    await client.close();
    await exposed.close();
    await gateway.close();

    // Telemetry captured both skill events.
    const lines = (await readFile(telemetryFile, "utf8")).trim().split("\n");
    const types = lines.map((l) => JSON.parse(l).type as string);
    expect(types).toContain("skill_search");
    expect(types).toContain("skill_invoke");
  });
});
