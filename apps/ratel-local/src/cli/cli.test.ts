import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BackupFs, JsonFs, ProjectRegistry } from "@ratel-ai/ratel-local-core";
import { AUTH_TOOL_ID } from "@ratel-ai/ratel-local-core";
import { INVOKE_TOOL_ID, SEARCH_CAPABILITIES_ID, SEARCH_TOOLS_ID } from "@ratel-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

const HOME = "/home/u";
const ROOT = "/repo";
const SETTINGS = "/home/u/.claude/settings.json";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, contents: string) {
    this.files.set(path, contents);
  }

  async writeAtomic(path: string, contents: string) {
    this.files.set(path, contents);
  }

  async remove(path: string) {
    this.files.delete(path);
  }

  async mkdirp() {}

  async exists(path: string) {
    return this.files.has(path);
  }

  async list(path: string) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash >= 0 ? rest.slice(0, slash) : rest);
    }
    return Array.from(names);
  }
}

let previousTelemetry: string | undefined;

beforeEach(() => {
  previousTelemetry = process.env.RATEL_TELEMETRY;
  process.env.RATEL_TELEMETRY = "off";
});

afterEach(() => {
  if (previousTelemetry === undefined) delete process.env.RATEL_TELEMETRY;
  else process.env.RATEL_TELEMETRY = previousTelemetry;
});

async function fakeUpstream() {
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping.", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

describe("runCli — serve", () => {
  it("reads the config, builds the gateway, and exposes search_capabilities + invoke_tool over the given downstream transport", async () => {
    const upstream = await fakeUpstream();
    const [downstreamServerTransport, downstreamClientTransport] =
      InMemoryTransport.createLinkedPair();

    const { shutdown } = await runCli(["serve", "/fake/config.json", "--telemetry", "off"], {
      readConfig: async () => ({
        mcpServers: { up: { type: "stdio", command: "noop" } },
        // Isolate from the machine's real ~/.ratel/skills so get_skill_content
        // isn't conditionally exposed based on whatever skills are activated.
        skills: { dirs: ["/nonexistent-ratel-cli-test-skills"] },
      }),
      transportFactory: () => upstream.clientTransport,
      serverTransport: downstreamServerTransport,
      logger: () => {},
    });

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(downstreamClientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [SEARCH_CAPABILITIES_ID, INVOKE_TOOL_ID, AUTH_TOOL_ID, SEARCH_TOOLS_ID].sort(),
    );

    const search = await client.callTool({
      name: SEARCH_CAPABILITIES_ID,
      arguments: { query: "ping" },
    });
    const text = (search.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as {
      tools: { groups: Array<{ server: { name: string }; hits: Array<{ toolId: string }> }> };
    };
    expect(parsed.tools.groups[0].server.name).toBe("up");
    expect(parsed.tools.groups[0].hits[0].toolId).toBe("up__ping");

    await client.close();
    await shutdown?.();
    await upstream.server.close();
  });

  it("threads upstream descriptions and tool counts into search_capabilities' listed description", async () => {
    const upstream = await fakeUpstream();
    const [downstreamServerTransport, downstreamClientTransport] =
      InMemoryTransport.createLinkedPair();

    const { shutdown } = await runCli(["serve", "/fake/config.json", "--telemetry", "off"], {
      readConfig: async () => ({
        mcpServers: {
          up: { type: "stdio", command: "noop", description: "ping server" },
        },
      }),
      transportFactory: () => upstream.clientTransport,
      serverTransport: downstreamServerTransport,
      logger: () => {},
    });

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(downstreamClientTransport);
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === SEARCH_CAPABILITIES_ID);
    expect(search?.description).toContain("upstream MCP servers");
    expect(search?.description).toContain("- up — ping server (1 tools)");

    await client.close();
    await shutdown?.();
    await upstream.server.close();
  });

  it("rejects when no config path is provided, with a usage message", async () => {
    await expect(runCli(["serve"], { logger: () => {} })).rejects.toThrow(/usage/i);
  });

  it("propagates a clear error when the config file cannot be read", async () => {
    await expect(
      runCli(["serve", "/missing.json"], {
        readConfig: async () => {
          throw new Error("ENOENT");
        },
        logger: () => {},
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("propagates parseConfig errors with the field path when the JSON is malformed", async () => {
    await expect(
      runCli(["serve", "/bad.json"], {
        readConfig: async () => ({ mcpServers: { fs: { type: "stdio" } } }),
        logger: () => {},
      }),
    ).rejects.toThrow(/mcpServers\.fs\.command/);
  });

  it("logs a ready line to the injected logger after wiring", async () => {
    const upstream = await fakeUpstream();
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];

    const { shutdown } = await runCli(["serve", "/x", "--telemetry", "off"], {
      readConfig: async () => ({
        mcpServers: { up: { type: "stdio", command: "noop" } },
        // Isolate from the machine's real ~/.ratel/skills so get_skill_content
        // isn't conditionally exposed based on whatever skills are activated.
        skills: { dirs: ["/nonexistent-ratel-cli-test-skills"] },
      }),
      transportFactory: () => upstream.clientTransport,
      serverTransport,
      logger: (m) => logs.push(m),
    });

    expect(logs.some((m) => /ready/i.test(m))).toBe(true);

    await shutdown?.();
    await upstream.server.close();
  });

  it("merges repeated --config files (right-wins) before running the server", async () => {
    const upstream = await fakeUpstream();
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const reads: string[] = [];

    const { shutdown } = await runCli(
      ["serve", "--config", "/a.json", "--config", "/b.json", "--telemetry", "off"],
      {
        readConfig: async (path) => {
          reads.push(path);
          if (path === "/a.json") {
            return { mcpServers: { up: { type: "stdio", command: "from-a" } } };
          }
          return { mcpServers: { up: { type: "stdio", command: "from-b" } } };
        },
        transportFactory: () => upstream.clientTransport,
        serverTransport,
        logger: () => {},
      },
    );

    expect(reads).toEqual(["/a.json", "/b.json"]);

    await shutdown?.();
    await upstream.server.close();
  });
});

describe("runCli — help and routing", () => {
  it("--help advertises the scoped daemon, project, and skill control plane", async () => {
    const logs: string[] = [];
    await runCli(["--help"], { logger: (m) => logs.push(m) });
    const out = logs.join("\n");
    expect(out).toMatch(/mcp/);
    expect(out).toMatch(/backup/);
    expect(out).toMatch(/^\s*import\s/m);
    expect(out).toMatch(/^\s*link\s/m);
    expect(out).toMatch(/^\s*setup\s/m);
    expect(out).toMatch(/^\s*project\s/m);
    expect(out).toMatch(/^\s*doctor\s/m);
    expect(out).toMatch(/daemon open/);
    expect(out).toMatch(/skill import/);
    expect(out).toMatch(/remove-scope/);
  });

  it("prints command-specific help for import and link without running either workflow", async () => {
    for (const command of ["import", "link"] as const) {
      const fs = new MemFs();
      const logs: string[] = [];

      await runCli([command, "--help", "--yes"], {
        env: { homeDir: HOME, projectRoot: ROOT },
        fs,
        logger: (message) => logs.push(message),
      });

      expect(logs.join("\n")).toContain(`usage: ratel-local ${command}`);
      expect(fs.files.size).toBe(0);
    }
  });

  it("--version logs the injected package version", async () => {
    const logs: string[] = [];
    await runCli(["--version"], { cliVersion: "1.2.3", logger: (m) => logs.push(m) });
    expect(logs).toEqual(["1.2.3"]);
  });

  it("`ratel-local mcp` (no verb) logs the mcp group usage", async () => {
    const logs: string[] = [];
    await runCli(["mcp"], { logger: (m) => logs.push(m) });
    const out = logs.join("\n");
    expect(out).toMatch(/add/);
    expect(out).not.toMatch(/^\s*import\s/m);
    expect(out).not.toMatch(/^\s*link\s/m);
  });

  it("`ratel-local backup` (no verb) logs the backup group usage", async () => {
    const logs: string[] = [];
    await runCli(["backup"], { logger: (m) => logs.push(m) });
    const out = logs.join("\n");
    expect(out).toMatch(/list/);
    expect(out).not.toMatch(/undo/);
  });

  it("routes project commands through the injected registry factory", async () => {
    const logs: string[] = [];
    const homes: string[] = [];
    const registry: ProjectRegistry = {
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
    };

    await runCli(["project", "list"], {
      env: { homeDir: HOME },
      logger: (message) => logs.push(message),
      projectRegistryFactory: (homeDir) => {
        homes.push(homeDir);
        return registry;
      },
    });

    expect(homes).toEqual([HOME]);
    expect(logs).toEqual(["no projects registered"]);
  });

  it("routes doctor through recovery and scoped diagnostics", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-cli-doctor-"));
    const logs: string[] = [];
    try {
      await runCli(["doctor"], {
        env: { homeDir },
        logger: (message) => logs.push(message),
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }

    expect(logs.at(-1)).toBe("doctor: ok (1 context checked)");
  });

  it("`ratel-local setup --help` describes interactive and automated setup", async () => {
    const logs: string[] = [];
    await runCli(["setup", "--help"], { logger: (message) => logs.push(message) });
    const out = logs.join("\n");
    expect(out).toContain("--yes");
    expect(out).toContain("--port N");
  });

  it("rejects an unknown command with ArgError", async () => {
    await expect(runCli(["mcps"], { logger: () => {} })).rejects.toThrow(/mcps/);
  });

  it("rejects an unknown mcp verb", async () => {
    await expect(runCli(["mcp", "fly"], { logger: () => {} })).rejects.toThrow(/fly/);
  });

  it("rejects an unknown backup verb", async () => {
    await expect(runCli(["backup", "purge"], { logger: () => {} })).rejects.toThrow(/purge/);
  });
});

describe("runCli — statusline", () => {
  it("renders statusline output to stdout from stdin", async () => {
    const fs = new MemFs();
    const stdout: string[] = [];
    await runCli(["statusline"], {
      env: { homeDir: HOME, projectRoot: ROOT },
      fs,
      logger: () => {},
      stdin: async () =>
        JSON.stringify({
          model: { display_name: "Claude Sonnet" },
          workspace: { project_dir: ROOT },
          context_window: { context_window_size: 100_000, used_percentage: 10 },
          cost: { total_duration_ms: 60_000 },
        }),
      stdout: (message) => stdout.push(message),
    });

    expect(stdout.join("")).toContain("Claude Sonnet");
    expect(stdout.join("")).toContain("10k / 100k");
  });

  it("installs and uninstalls the Claude statusline with --yes", async () => {
    const fs = new MemFs();
    fs.files.set("/repo/dist/bin.js", "");
    const logs: string[] = [];
    await runCli(["statusline", "install", "--yes"], {
      env: { homeDir: HOME, projectRoot: ROOT },
      fs,
      logger: (message) => logs.push(message),
    });

    expect(JSON.parse(fs.files.get(SETTINGS) as string).statusLine.command).toContain("statusline");
    expect(logs.join("\n")).toContain("installed Ratel statusline");

    await runCli(["statusline", "uninstall", "--yes"], {
      env: { homeDir: HOME, projectRoot: ROOT },
      fs,
      logger: (message) => logs.push(message),
    });
    expect(JSON.parse(fs.files.get(SETTINGS) as string).statusLine).toBeUndefined();
  });
});
