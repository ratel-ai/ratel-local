import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BackupFs } from "./backup.js";
import { type JsonFs, nodeFs } from "./io.js";
import { createMutationEngine, MISSING_DOCUMENT_REVISION } from "./mutation-engine.js";
import {
  addServerEntry,
  applyAgentImportAgent,
  applyAgentImportRatel,
  applyAgentLink,
  applyCombinedAgentImport,
  editServerEntry,
  getAgentHostsState,
  getConfigState,
  importAgentServers,
  linkAgentToRatel,
  previewAgentImport,
  previewAgentLink,
  removeAgentRatelMcpFallback,
  removeServerEntry,
} from "./operations.js";
import { executePlan } from "./plan-exec.js";

const HOME = "/home/u";
const ROOT = "/repo";
const USER_PATH = "/home/u/.ratel/config.json";
const CLAUDE_PATH = "/home/u/.claude.json";
const CLAUDE_SETTINGS_PATH = "/home/u/.claude/settings.json";
const CODEX_PATH = "/home/u/.codex/config.toml";

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

function ctx(fs = new MemFs()) {
  return {
    env: { homeDir: HOME, projectRoot: ROOT },
    fs,
    log: () => {},
    planExecutor: executePlan,
  };
}

describe("core operations — server entries", () => {
  it("adds, edits, and removes entries with backups", async () => {
    const fs = new MemFs();
    await addServerEntry(ctx(fs), {
      scope: "user",
      name: "fs",
      entry: { type: "stdio", command: "echo" },
    });
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe("echo");

    await editServerEntry(ctx(fs), {
      scope: "user",
      name: "fs",
      entry: { type: "stdio", command: "node", args: ["server.js"] },
    });
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.args).toEqual(["server.js"]);

    await removeServerEntry(ctx(fs), { scope: "user", name: "fs" });
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers).toEqual({});
    expect([...fs.files.keys()].some((path) => path.includes("/.ratel/backups/"))).toBe(true);
  });

  it("mutates a skills-only document without dropping unknown fields", async () => {
    const fs = new MemFs();
    fs.files.set(USER_PATH, JSON.stringify({ skills: { dirs: [] }, custom: { keep: "yes" } }));

    await addServerEntry(ctx(fs), {
      scope: "user",
      name: "fs",
      entry: { type: "stdio", command: "echo" },
    });

    const document = JSON.parse(fs.files.get(USER_PATH) as string);
    expect(document.skills).toEqual({ dirs: [] });
    expect(document.custom).toEqual({ keep: "yes" });
    expect(document.mcpServers.fs.command).toBe("echo");
  });
});

describe("core operations — config state", () => {
  it("reports scope configs and auth status", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({
        mcpServers: {
          local: { type: "stdio", command: "echo" },
          remote: { type: "http", url: "https://example.com/mcp" },
          expired: { type: "http", url: "https://expired.example/mcp" },
          ready: { type: "http", url: "https://ready.example/mcp" },
          unsupported: { type: "http", url: "https://unsupported.example/mcp" },
          recovered: { type: "http", url: "https://recovered.example/mcp" },
        },
      }),
    );
    fs.files.set(
      `${HOME}/.ratel/oauth/expired.json`,
      JSON.stringify({ tokens: { access_token: "x" }, expires_at: Date.now() - 1000 }),
    );
    fs.files.set(
      `${HOME}/.ratel/oauth/ready.json`,
      JSON.stringify({ tokens: { access_token: "x" }, expires_at: Date.now() + 100000 }),
    );
    fs.files.set(
      `${HOME}/.ratel/oauth/unsupported.json`,
      JSON.stringify({
        unsupported: {
          reason: "OAuth client registration was rejected",
          detected_at: new Date().toISOString(),
        },
      }),
    );
    fs.files.set(
      `${HOME}/.ratel/oauth/recovered.json`,
      JSON.stringify({
        tokens: { access_token: "x" },
        unsupported: {
          reason: "OAuth client registration was rejected",
          detected_at: new Date().toISOString(),
        },
      }),
    );

    const state = await getConfigState(ctx(fs));
    expect(state.scopes.user.available).toBe(true);
    if (!state.scopes.user.available) throw new Error("expected user scope");
    expect(state.scopes.user.authStatus.local).toBe("n/a");
    expect(state.scopes.user.authStatus.remote).toBe("needs auth");
    expect(state.scopes.user.authStatus.expired).toBe("expired");
    expect(state.scopes.user.authStatus.ready).toBe("ok");
    expect(state.scopes.user.authStatus.unsupported).toBe("unsupported");
    expect(state.scopes.user.authStatus.recovered).toBe("ok");
  });
});

describe("core operations — agent interop", () => {
  it("reports an enabled Claude Ratel plugin as the host connection", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ enabledPlugins: { "ratel-local@ratel": true } }),
    );

    const state = await getAgentHostsState(ctx(fs));
    const claude = state.hosts.find((host) => host.kind === "claude-code");

    expect(claude?.connection).toEqual({
      kind: "plugin",
      linked: true,
      explicit: false,
      plugin: true,
    });
    expect(claude?.posture).toBe("mixed");
    expect(claude?.ratelEntryCount).toBe(0);
  });

  it("reports detected agent posture for supported hosts", async () => {
    const fs = new MemFs();
    let state = await getAgentHostsState(ctx(fs));
    expect(state.hosts.map((host) => [host.kind, host.posture])).toEqual([
      ["claude-code", "unavailable"],
      ["codex", "unavailable"],
    ]);

    fs.files.set(CLAUDE_PATH, JSON.stringify({}));
    state = await getAgentHostsState(ctx(fs));
    expect(state.hosts.find((host) => host.kind === "claude-code")?.posture).toBe("empty");

    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    state = await getAgentHostsState(ctx(fs));
    expect(state.hosts.find((host) => host.kind === "claude-code")?.posture).toBe("not-linked");

    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        mcpServers: {
          "ratel-local": {
            type: "stdio",
            command: "ratel-local",
            args: ["connect", "--agent-host", "claude-code", "--link-scope", "user"],
          },
        },
      }),
    );
    state = await getAgentHostsState(ctx(fs));
    expect(state.hosts.find((host) => host.kind === "claude-code")?.posture).toBe("ratel-only");

    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          "ratel-local": {
            type: "stdio",
            command: "ratel-local",
            args: ["connect", "--agent-host", "claude-code", "--link-scope", "user"],
          },
        },
      }),
    );
    state = await getAgentHostsState(ctx(fs));
    expect(state.hosts.find((host) => host.kind === "claude-code")?.posture).toBe("mixed");
  });

  it("reports an enabled Codex Ratel plugin as the host connection", async () => {
    const fs = new MemFs();
    fs.files.set(
      CODEX_PATH,
      `[plugins."ratel-local@ratel"]
enabled = true

[mcp_servers.fs]
command = "echo"
`,
    );

    const state = await getAgentHostsState(ctx(fs));
    const codex = state.hosts.find((host) => host.kind === "codex");

    expect(codex?.connection).toEqual({
      kind: "plugin",
      linked: true,
      explicit: false,
      plugin: true,
    });
    expect(codex?.posture).toBe("mixed");
    expect(codex?.ratelEntryCount).toBe(0);
  });

  it("does not treat an explicitly disabled Codex plugin as a connection", async () => {
    const fs = new MemFs();
    fs.files.set(
      CODEX_PATH,
      `[plugins."ratel-local@ratel"]
enabled = false

[mcp_servers.fs]
command = "echo"
`,
    );

    const state = await getAgentHostsState(ctx(fs));
    const codex = state.hosts.find((host) => host.kind === "codex");

    expect(codex?.connection).toEqual({
      kind: "none",
      linked: false,
      explicit: false,
      plugin: false,
    });
    expect(codex?.posture).toBe("not-linked");
  });

  it("re-enables a disabled Codex plugin MCP instead of adding an explicit gateway", async () => {
    const fs = new MemFs();
    fs.files.set(
      CODEX_PATH,
      `[plugins."ratel-local@ratel"]
enabled = true

[plugins."ratel-local@ratel".mcp_servers.ratel-local]
enabled = false # keep this comment

[mcp_servers.fs]
command = "echo"
`,
    );

    const state = await getAgentHostsState(ctx(fs));
    const codex = state.hosts.find((host) => host.kind === "codex");
    expect(codex?.connection).toEqual({
      kind: "none",
      linked: false,
      explicit: false,
      plugin: false,
      pluginDisabled: true,
    });

    const preview = await previewAgentLink(ctx(fs), { hostKind: "codex" });
    expect(preview.plan.agentChanges).toHaveLength(1);
    expect(preview.plan.agentChanges[0]?.after).toContain("enabled = true # keep this comment");
    expect(preview.plan.agentChanges[0]?.after).not.toContain("[mcp_servers.ratel-local]");

    await applyAgentLink(ctx(fs), {
      hostKind: "codex",
      planHash: preview.stageHashes.agent,
    });
    const after = fs.files.get(CODEX_PATH) as string;
    expect(after).toContain("enabled = true # keep this comment");
    expect(after).not.toContain("[mcp_servers.ratel-local]");
  });

  it("keeps host discovery working when Claude plugin settings cannot be read", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const read = fs.read.bind(fs);
    fs.read = async (path: string) => {
      if (path === CLAUDE_SETTINGS_PATH) throw new Error("permission denied");
      return read(path);
    };

    const state = await getAgentHostsState(ctx(fs));
    const claude = state.hosts.find((host) => host.kind === "claude-code");

    expect(claude?.connection.linked).toBe(false);
    expect(claude?.detection.warnings.join("\n")).toMatch(/permission denied/i);
  });

  it("reports plugin plus explicit MCP as a duplicate without changing either connection", async () => {
    const fs = new MemFs();
    const claudeBefore = JSON.stringify({
      mcpServers: {
        "ratel-local": { type: "stdio", command: "ratel-local" },
      },
    });
    fs.files.set(CLAUDE_PATH, claudeBefore);
    fs.files.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ enabledPlugins: { "ratel-local@ratel": true } }),
    );

    const state = await getAgentHostsState(ctx(fs));
    const claude = state.hosts.find((host) => host.kind === "claude-code");
    expect(claude?.connection).toEqual({
      kind: "duplicate",
      linked: true,
      explicit: true,
      plugin: true,
    });

    const preview = await previewAgentLink(ctx(fs), { hostKind: "claude-code" });
    expect(preview.plan.agentChanges).toEqual([]);
    expect(preview.emptyReason).toMatch(/duplicate Ratel connections/i);
    expect(fs.files.get(CLAUDE_PATH)).toBe(claudeBefore);
  });

  it("removes only the explicit Claude Ratel fallback", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          "ratel-local": { type: "stdio", command: "ratel-local" },
        },
      }),
    );

    await removeAgentRatelMcpFallback(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "ratel-local" },
    );

    expect(JSON.parse(fs.files.get(CLAUDE_PATH) as string).mcpServers).toEqual({
      fs: { type: "stdio", command: "echo" },
    });
  });

  it("removes only the explicit Codex Ratel fallback", async () => {
    const fs = new MemFs();
    fs.files.set(
      CODEX_PATH,
      [
        "[mcp_servers.fs]",
        'command = "echo"',
        "",
        "[mcp_servers.ratel-local]",
        'command = "ratel-local"',
        "",
      ].join("\n"),
    );

    await removeAgentRatelMcpFallback(ctx(fs), { hostKind: "codex" }, { envVar: "ratel-local" });

    expect(fs.files.get(CODEX_PATH)).toContain("[mcp_servers.fs]");
    expect(fs.files.get(CODEX_PATH)).not.toContain("[mcp_servers.ratel-local]");
  });

  it("previews and applies import in Ratel and agent stages", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    const preview = await previewAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    expect(preview.candidates.map((candidate) => candidate.name)).toEqual(["fs"]);
    expect(preview.plan.ratelChanges).toHaveLength(1);
    expect(preview.plan.agentChanges).toHaveLength(1);

    await applyAgentImportRatel(
      ctx(fs),
      {
        hostKind: "claude-code",
        selection: preview.selected,
        planHash: preview.stageHashes.ratel,
      },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe("echo");
    expect(JSON.parse(fs.files.get(CLAUDE_PATH) as string).mcpServers.fs.command).toBe("echo");

    await applyAgentImportAgent(
      ctx(fs),
      {
        hostKind: "claude-code",
        selection: preview.selected,
        planHash: preview.stageHashes.agent,
      },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs).toBeUndefined();
    expect(claude.mcpServers["ratel-local"]).toBeUndefined();
  });

  it("includes a local Git exclude edit in the same Ratel import stage", async () => {
    const fs = new MemFs();
    const excludePath = `${ROOT}/.git/info/exclude`;
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        projects: {
          [ROOT]: { mcpServers: { local: { type: "stdio", command: "echo" } } },
        },
      }),
    );

    const preview = await previewAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      {
        envVar: "/usr/local/bin/ratel-local",
        localGitExcludeManager: {
          async preview(projectRoot) {
            return {
              projectRoot,
              excludePath,
              changed: true,
              currentContents: "# keep\n",
              contents: "# keep\n# ratel local\n",
              documentRevision: MISSING_DOCUMENT_REVISION,
            };
          },
          async ensure(projectRoot) {
            return { projectRoot, excludePath, changed: true };
          },
        },
      },
    );

    expect(preview.plan.ratelChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `${ROOT}/.ratel/config.local.json` }),
        {
          kind: "write",
          path: excludePath,
          before: "# keep\n",
          after: "# keep\n# ratel local\n",
        },
      ]),
    );
  });

  it("rejects stale import plan hashes before applying", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    const preview = await previewAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "node" } } }),
    );

    await expect(
      applyAgentImportRatel(
        ctx(fs),
        {
          hostKind: "claude-code",
          selection: preview.selected,
          planHash: preview.stageHashes.ratel,
        },
        { envVar: "/usr/local/bin/ratel-local" },
      ),
    ).rejects.toThrow(/preview is stale/);
  });

  it("binds and applies both import stages together", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const preview = await previewAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );

    await applyCombinedAgentImport(
      ctx(fs),
      {
        hostKind: "claude-code",
        selection: preview.selected,
        stageHashes: preview.stageHashes,
      },
      { envVar: "/usr/local/bin/ratel-local" },
    );

    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe("echo");
    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs).toBeUndefined();
    expect(claude.mcpServers["ratel-local"]).toBeUndefined();
  });

  it("previews and applies link without removing native agent entries", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "node" },
        },
      }),
    );

    const preview = await previewAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    expect(preview.candidates).toEqual([]);
    expect(preview.selected).toEqual([]);
    expect(preview.plan.ratelChanges).toHaveLength(0);
    expect(preview.plan.agentChanges).toHaveLength(1);

    await applyAgentLink(
      ctx(fs),
      {
        hostKind: "claude-code",
        planHash: preview.stageHashes.agent,
      },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs.command).toBe("echo");
    expect(claude.mcpServers.other.command).toBe("node");
    expect(claude.mcpServers["ratel-local"].args).toEqual([
      "connect",
      "--agent-host",
      "claude-code",
      "--link-scope",
      "user",
    ]);
  });

  it("previews link as a plugin-aware no-op without an explicit gateway", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ enabledPlugins: { "ratel-local@ratel": true } }),
    );

    const preview = await previewAgentLink(ctx(fs), { hostKind: "claude-code" });

    expect(preview.plan.agentChanges).toEqual([]);
    expect(preview.emptyReason).toMatch(/linked through the Ratel Local plugin/i);
  });

  it("links the Ratel gateway even when native agent entries do not match Ratel entries", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { stripe: { type: "http", url: "https://mcp.stripe.com" } } }),
    );
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
        },
      }),
    );

    const preview = await previewAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    expect(preview.candidates).toEqual([]);
    expect(preview.selected).toEqual([]);
    expect(preview.plan.ratelChanges).toHaveLength(0);
    expect(preview.plan.agentChanges).toHaveLength(1);

    await applyAgentLink(
      ctx(fs),
      {
        hostKind: "claude-code",
        planHash: preview.stageHashes.agent,
      },
      { envVar: "/usr/local/bin/ratel-local" },
    );
    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs.command).toBe("echo");
    expect(claude.mcpServers["ratel-local"].args).toEqual([
      "connect",
      "--agent-host",
      "claude-code",
      "--link-scope",
      "user",
    ]);
  });

  it("links the Ratel gateway into an empty Claude Code config", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(CLAUDE_PATH, JSON.stringify({}));

    const preview = await previewAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );

    expect(preview.plan.agentChanges).toHaveLength(1);
    expect(preview.emptyReason).toBeNull();
  });

  it("previews a link for a skills-only Ratel document", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({
        skills: { entries: { review: { mode: "reference", path: "/skills/review" } } },
      }),
    );
    fs.files.set(CLAUDE_PATH, JSON.stringify({}));

    const preview = await previewAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );

    expect(preview.plan.agentChanges).toHaveLength(1);
    expect(preview.emptyReason).toBeNull();
  });

  it("previews a link for an implicit default user skill directory", async () => {
    const fs = new MemFs();
    fs.files.set(USER_PATH, JSON.stringify({ custom: true }));
    fs.files.set(
      "/home/u/.ratel/skills/review/SKILL.md",
      "---\nname: review\ndescription: review\n---\n",
    );
    fs.files.set(CLAUDE_PATH, JSON.stringify({}));

    const preview = await previewAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local" },
    );

    expect(preview.plan.agentChanges).toHaveLength(1);
    expect(preview.emptyReason).toBeNull();
  });

  it("imports Claude Code entries non-interactively", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    await importAgentServers(ctx(fs), { envVar: "/usr/local/bin/ratel-local" });

    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe("echo");
    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs).toBeUndefined();
    expect(claude.mcpServers["ratel-local"]).toBeUndefined();
  });

  it("rolls back a non-interactive import when the agent rewrite fails after the Ratel write", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-core-import-transaction-"));
    try {
      const claudePath = join(homeDir, ".claude.json");
      const ratelPath = join(homeDir, ".ratel", "config.json");
      const originalClaude = JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      });
      await writeFile(claudePath, originalClaude, "utf8");
      const mutationEngine = await createMutationEngine({
        controlDir: join(homeDir, ".ratel"),
        hooks: {
          beforeApplyOperation(_operation, index) {
            if (index === 1) throw new Error("fail-core-agent-publication");
          },
        },
      });

      await expect(
        importAgentServers(
          { env: { homeDir }, fs: nodeFs, log: () => {} },
          {
            envVar: "/usr/local/bin/ratel-local",
            mutationEngine,
          },
        ),
      ).rejects.toThrow("fail-core-agent-publication");

      await expect(readFile(ratelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(claudePath, "utf8")).toBe(originalClaude);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves unknown Ratel document fields through a transactional agent import", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-core-import-lossless-"));
    try {
      const claudePath = join(homeDir, ".claude.json");
      const ratelPath = join(homeDir, ".ratel", "config.json");
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      await writeFile(
        claudePath,
        JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
        "utf8",
      );
      await writeFile(
        ratelPath,
        JSON.stringify({ custom: { keep: true }, skills: { dirs: [] } }),
        "utf8",
      );

      await importAgentServers(
        { env: { homeDir }, fs: nodeFs, log: () => {} },
        { envVar: "/usr/local/bin/ratel-local" },
      );

      const document = JSON.parse(await readFile(ratelPath, "utf8"));
      expect(document.custom).toEqual({ keep: true });
      expect(document.skills).toEqual({ dirs: [] });
      expect(document.mcpServers.fs.command).toBe("echo");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("links Claude Code non-interactively without removing native entries", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    await linkAgentToRatel(ctx(fs), { envVar: "/usr/local/bin/ratel-local" });

    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs.command).toBe("echo");
    expect(claude.mcpServers["ratel-local"].args).toEqual([
      "connect",
      "--agent-host",
      "claude-code",
      "--link-scope",
      "user",
    ]);
  });

  it("rejects a native project Codex config behind an escaping .codex symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-codex-path-safety-"));
    try {
      const homeDir = join(root, "home");
      const projectRoot = join(root, "project");
      const outside = join(root, "outside-codex");
      await mkdir(homeDir, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "config.toml"), '[mcp_servers.escape]\ncommand = "echo"\n');
      await symlink(outside, join(projectRoot, ".codex"));

      await expect(
        previewAgentLink(
          { env: { homeDir, projectRoot }, fs: nodeFs, log: () => {} },
          { hostKind: "codex" },
          { bin: { command: "/usr/local/bin/ratel-local", args: [], source: "env" } },
        ),
      ).rejects.toMatchObject({ statusCode: 422, code: "PROJECT_PATH_UNSAFE" });
      await expect(readFile(join(outside, "config.toml"), "utf8")).resolves.toContain(
        "mcp_servers.escape",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects native project Ratel config behind an escaping .ratel symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-config-path-safety-"));
    try {
      const homeDir = join(root, "home");
      const projectRoot = join(root, "project");
      const outside = join(root, "outside-ratel");
      await mkdir(homeDir, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      const outsideConfig = join(outside, "config.json");
      await writeFile(outsideConfig, '{"mcpServers":{"escape":{"command":"echo"}}}\n');
      await symlink(outside, join(projectRoot, ".ratel"));

      await expect(
        getAgentHostsState({ env: { homeDir, projectRoot }, fs: nodeFs, log: () => {} }),
      ).rejects.toMatchObject({ statusCode: 422, code: "PROJECT_PATH_UNSAFE" });
      await expect(readFile(outsideConfig, "utf8")).resolves.toContain('"escape"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves plugin-linked Claude Code unchanged in the non-interactive link operation", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ enabledPlugins: { "ratel-local@ratel": true } }),
    );
    const logs: string[] = [];

    const manifest = await linkAgentToRatel({
      env: { homeDir: HOME, projectRoot: ROOT },
      fs,
      log: (message) => logs.push(message),
    });

    expect(manifest).toBeNull();
    expect(fs.files.has(CLAUDE_PATH)).toBe(false);
    expect(logs.join("\n")).toMatch(/linked through the Ratel Local plugin/i);
  });
});
