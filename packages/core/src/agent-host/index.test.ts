import { describe, expect, it } from "vitest";
import {
  type AgentHostAdapter,
  type AgentHostContext,
  AutomaticAgentHostAdapter,
  NamedAgentHostAdapter,
} from "./index.js";

function adapter(input: {
  kind: string;
  displayName: string;
  present: boolean;
  mcpServers?: Record<string, { type: string; command?: string; args?: string[] }>;
}): AgentHostAdapter {
  return {
    supportedScopes: ["user"],
    async detect() {
      return {
        displayName: input.displayName,
        present: input.present,
        reasons: input.present ? [`Found ${input.displayName}`] : [],
        warnings: [],
      };
    },
    async read() {
      return {
        host: { kind: input.kind, displayName: input.displayName },
        scopes: [
          {
            scope: "user",
            displayName: "User",
            path: `/${input.kind}.json`,
            available: input.present,
            mcpServers: input.mcpServers ?? {},
          },
        ],
      };
    },
    async planChanges() {
      return {
        changes: [],
        summary: {
          host: { kind: input.kind, displayName: input.displayName },
          installedGatewayScopes: [],
          removedNativeEntries: [],
          warnings: [],
        },
      };
    },
  };
}

const CTX: AgentHostContext = {
  env: { homeDir: "/home/u", projectRoot: "/r" },
  fs: {
    read: async () => null,
    writeAtomic: async () => {},
    exists: async () => false,
  },
};

describe("AutomaticAgentHostAdapter", () => {
  it("prefers a later present host with native MCPs over an earlier empty host", async () => {
    const automatic = new AutomaticAgentHostAdapter([
      adapter({ kind: "claude-code", displayName: "Claude Code", present: true }),
      adapter({
        kind: "codex",
        displayName: "Codex",
        present: true,
        mcpServers: { filesystem: { type: "stdio", command: "npx" } },
      }),
    ]);

    const detection = await automatic.detect(CTX);
    const state = await automatic.read(CTX);

    expect(detection.displayName).toBe("Codex");
    expect(state.host.kind).toBe("codex");
  });
});

describe("NamedAgentHostAdapter", () => {
  it("declares the native scopes each host can link", () => {
    expect(new NamedAgentHostAdapter("claude-code").supportedScopes).toEqual([
      "user",
      "project",
      "local",
    ]);
    expect(new NamedAgentHostAdapter("codex").supportedScopes).toEqual(["user", "project"]);
  });

  it("resolves concrete supported adapters by kind", async () => {
    const claude = await new NamedAgentHostAdapter("claude-code").detect(CTX);
    const codex = await new NamedAgentHostAdapter("codex").detect(CTX);

    expect(claude.displayName).toBe("Claude Code");
    expect(codex.displayName).toBe("Codex");
  });
});
