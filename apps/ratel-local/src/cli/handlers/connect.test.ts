import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BackupFs, JsonFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it } from "vitest";
import { silentPromptAdapter } from "../prompts.js";
import { type ConnectBackendInput, runConnect } from "./connect.js";

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
  async list() {
    return [];
  }
}

describe("runConnect", () => {
  it("passes the resolved project root and daemon token to the HTTP backend", async () => {
    const remoteServer = new Server(
      { name: "daemon", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    remoteServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    const [remoteServerTransport, remoteClientTransport] = InMemoryTransport.createLinkedPair();
    await remoteServer.connect(remoteServerTransport);
    const remoteClient = new Client({ name: "connector", version: "1.0.0" });
    await remoteClient.connect(remoteClientTransport);
    const [connectorTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const fs = new MemFs();
    const inputs: ConnectBackendInput[] = [];

    const connector = await runConnect(
      {
        group: "connect",
        configPaths: [],
        rest: [],
        extras: [],
        flags: {
          "project-root": "/repo",
          "daemon-url": "http://127.0.0.1:5731/mcp",
          "agent-host": "codex",
          "link-scope": "project",
        },
      },
      {
        argv: {
          group: "connect",
          configPaths: [],
          rest: [],
          extras: [],
          flags: {},
        },
        env: { homeDir: "/home/u" },
        fs,
        log: () => {},
        prompts: silentPromptAdapter(),
      },
      {
        connectorTransport,
        cliVersion: "1.2.3",
        readToken: async () => "secret",
        connectBackend: async (input) => {
          inputs.push(input);
          return remoteClient;
        },
      },
      () => {},
    );
    const host = new Client({ name: "host", version: "1.0.0" });
    await host.connect(hostTransport);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      token: "secret",
      projectRoot: "/repo",
      clientVersion: "1.2.3",
      agentHost: "codex",
      linkScope: "project",
    });

    await host.close();
    await connector.shutdown();
    await remoteServer.close();
  });

  it.each([
    [{ "agent-host": "cursor" }, /--agent-host must be one of: claude-code, codex/],
    [{ "link-scope": "workspace" }, /--link-scope must be one of: user, project, local/],
    [{ "agent-host": true }, /--agent-host must be one of: claude-code, codex/],
  ] as const)("rejects invalid connector metadata flags", async (flags, message) => {
    const fs = new MemFs();

    await expect(
      runConnect(
        {
          group: "connect",
          configPaths: [],
          rest: [],
          extras: [],
          flags: { ...flags, "daemon-url": "http://127.0.0.1:5731/mcp" },
        },
        {
          argv: {
            group: "connect",
            configPaths: [],
            rest: [],
            extras: [],
            flags: {},
          },
          env: { homeDir: "/home/u" },
          fs,
          log: () => {},
          prompts: silentPromptAdapter(),
        },
        { cliVersion: "1.2.3" },
        () => {},
      ),
    ).rejects.toThrow(message);
  });
});
