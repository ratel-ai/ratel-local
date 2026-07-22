import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BackupFs } from "./backup.js";
import { type JsonFs, nodeFs } from "./io.js";
import {
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  type MutationCommit,
  MutationConflictError,
  type PreparedMutation,
} from "./mutation-engine.js";
import {
  addServerEntry,
  editServerEntry,
  getAgentHostsState,
  getConfigState,
  prepareAgentImport,
  prepareAgentLink,
  prepareAgentRatelMcpFallbackRemoval,
  removeServerEntry,
} from "./operations.js";
import type {
  PrepareChangeInput,
  PreparedChangeCoordinator,
} from "./prepared-change-coordinator.js";

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
  };
}

interface StoredMemoryChange {
  input: PrepareChangeInput<unknown, unknown>;
  mutation: PreparedMutation;
}

function memoryPreparedChanges(fs: MemFs): PreparedChangeCoordinator {
  let nextId = 0;
  const changes = new Map<string, StoredMemoryChange>();
  return {
    async prepare<ReviewData, DomainResult>(input: PrepareChangeInput<ReviewData, DomainResult>) {
      const baseRevisions: PreparedMutation["baseRevisions"] = {};
      const operations: PreparedMutation["operations"] = [];
      const files: PreparedMutation["preview"]["files"] = [];
      for (const operation of input.operations) {
        if (operation.kind !== "replace-file") {
          throw new Error(`memory test coordinator does not support ${operation.kind}`);
        }
        const before = fs.files.get(operation.path) ?? null;
        const after =
          typeof operation.contents === "string"
            ? operation.contents
            : Buffer.from(operation.contents).toString("utf8");
        const beforeRevision =
          before === null ? MISSING_DOCUMENT_REVISION : documentRevision(before);
        baseRevisions[operation.path] = beforeRevision;
        operations.push({
          kind: "replace-file",
          path: operation.path,
          contentsBase64: Buffer.from(after).toString("base64"),
        });
        files.push({
          kind: "file",
          path: operation.path,
          existedBefore: before !== null,
          beforeRevision,
          afterRevision: documentRevision(after),
        });
      }
      const mutation: PreparedMutation = {
        id: `mutation-${nextId}`,
        digest: "memory-test" as PreparedMutation["digest"],
        baseRevisions,
        operations,
        preview: { files },
      };
      const preview = input.buildPreview
        ? input.buildPreview(structuredClone(mutation))
        : (input.preview as ReviewData);
      const changeId = `change-${nextId++}`;
      changes.set(changeId, {
        input: input as PrepareChangeInput<unknown, unknown>,
        mutation,
      });
      return {
        changeId,
        kind: input.kind,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        preview,
      };
    },
    async commit<DomainResult>(changeId: string) {
      const stored = changes.get(changeId);
      changes.delete(changeId);
      if (!stored) throw new Error(`unavailable prepared change: ${changeId}`);
      const decision = await stored.input.beforeCommit?.();
      if (decision?.action === "cancel") {
        return {
          transactionId: changeId,
          changedPaths: [],
          revisions: {},
          backupManifest: null,
          result: decision.result as DomainResult,
        };
      }
      await stored.input.invariants?.precondition?.();
      const revisions: MutationCommit["revisions"] = {};
      for (const [index, operation] of stored.mutation.operations.entries()) {
        const before = fs.files.get(operation.path) ?? null;
        const actual = before === null ? MISSING_DOCUMENT_REVISION : documentRevision(before);
        const expected = stored.mutation.baseRevisions[operation.path];
        if (actual !== expected) {
          throw new MutationConflictError(
            "revision_conflict",
            `document changed after preparation: ${operation.path}`,
            operation.path,
            expected,
            actual,
          );
        }
        await stored.input.invariants?.operationPrecondition?.(operation, index);
        if (operation.kind !== "replace-file") {
          throw new Error(`memory test coordinator does not support ${operation.kind}`);
        }
        const after = Buffer.from(operation.contentsBase64, "base64").toString("utf8");
        fs.files.set(operation.path, after);
        revisions[operation.path] = documentRevision(after);
      }
      const commit: MutationCommit = {
        transactionId: changeId,
        changedPaths: stored.mutation.operations.map(({ path }) => path),
        revisions,
      };
      const result =
        typeof stored.input.result === "function"
          ? await (stored.input.result as (commit: MutationCommit) => unknown)(commit)
          : stored.input.result;
      return { ...commit, backupManifest: null, result: result as DomainResult };
    },
    cancel(changeId: string) {
      changes.delete(changeId);
    },
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

    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentLink(ctx(fs), { hostKind: "codex" }, { preparedChanges });
    const preview = prepared.preview;
    expect(preview.plan.agentChanges).toHaveLength(1);
    expect(preview.plan.agentChanges[0]?.after).toContain("enabled = true # keep this comment");
    expect(preview.plan.agentChanges[0]?.after).not.toContain("[mcp_servers.ratel-local]");

    await preparedChanges.commit(prepared.changeId);
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

    const prepared = await prepareAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { preparedChanges: memoryPreparedChanges(fs) },
    );
    const preview = prepared.preview;
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

    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentRatelMcpFallbackRemoval(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "ratel-local", preparedChanges },
    );
    await preparedChanges.commit(prepared.changeId);

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

    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentRatelMcpFallbackRemoval(
      ctx(fs),
      { hostKind: "codex" },
      { envVar: "ratel-local", preparedChanges },
    );
    await preparedChanges.commit(prepared.changeId);

    expect(fs.files.get(CODEX_PATH)).toContain("[mcp_servers.fs]");
    expect(fs.files.get(CODEX_PATH)).not.toContain("[mcp_servers.ratel-local]");
  });

  it("prepares and commits Ratel and agent import changes atomically", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local", preparedChanges },
    );
    const preview = prepared.preview;
    expect(preview.candidates.map((candidate) => candidate.name)).toEqual(["fs"]);
    expect(preview.plan.ratelChanges).toHaveLength(1);
    expect(preview.plan.agentChanges).toHaveLength(1);

    await preparedChanges.commit(prepared.changeId);
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe("echo");
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
    fs.files.set(excludePath, "# keep\n");

    const prepared = await prepareAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      {
        envVar: "/usr/local/bin/ratel-local",
        preparedChanges: memoryPreparedChanges(fs),
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
    const preview = prepared.preview;

    expect(preview.plan.ratelChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `${ROOT}/.ratel/config.local.json` }),
        {
          path: excludePath,
          before: "# keep\n",
          after: "# keep\n# ratel local\n",
        },
      ]),
    );
  });

  it("rejects stale files when committing a prepared import", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local", preparedChanges },
    );
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "node" } } }),
    );

    await expect(preparedChanges.commit(prepared.changeId)).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
      reason: "revision_conflict",
    });
  });

  it("binds and applies both import stages together", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentImport(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local", preparedChanges },
    );
    await preparedChanges.commit(prepared.changeId);

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

    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local", preparedChanges },
    );
    const preview = prepared.preview;
    expect(preview.candidates).toEqual([]);
    expect(preview.selected).toEqual([]);
    expect(preview.plan.ratelChanges).toHaveLength(0);
    expect(preview.plan.agentChanges).toHaveLength(1);

    await preparedChanges.commit(prepared.changeId);
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

    const prepared = await prepareAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { preparedChanges: memoryPreparedChanges(fs) },
    );
    const preview = prepared.preview;

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

    const preparedChanges = memoryPreparedChanges(fs);
    const prepared = await prepareAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      { envVar: "/usr/local/bin/ratel-local", preparedChanges },
    );
    const preview = prepared.preview;
    expect(preview.candidates).toEqual([]);
    expect(preview.selected).toEqual([]);
    expect(preview.plan.ratelChanges).toHaveLength(0);
    expect(preview.plan.agentChanges).toHaveLength(1);

    await preparedChanges.commit(prepared.changeId);
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

    const prepared = await prepareAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      {
        envVar: "/usr/local/bin/ratel-local",
        preparedChanges: memoryPreparedChanges(fs),
      },
    );
    const preview = prepared.preview;

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

    const prepared = await prepareAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      {
        envVar: "/usr/local/bin/ratel-local",
        preparedChanges: memoryPreparedChanges(fs),
      },
    );
    const preview = prepared.preview;

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

    const prepared = await prepareAgentLink(
      ctx(fs),
      { hostKind: "claude-code" },
      {
        envVar: "/usr/local/bin/ratel-local",
        preparedChanges: memoryPreparedChanges(fs),
      },
    );
    const preview = prepared.preview;

    expect(preview.plan.agentChanges).toHaveLength(1);
    expect(preview.emptyReason).toBeNull();
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
        prepareAgentLink(
          { env: { homeDir, projectRoot }, fs: nodeFs, log: () => {} },
          { hostKind: "codex" },
          {
            bin: { command: "/usr/local/bin/ratel-local", args: [], source: "env" },
            preparedChanges: memoryPreparedChanges(new MemFs()),
          },
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
});
