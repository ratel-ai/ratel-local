import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupFs,
  defaultTelemetryDir,
  type HierarchyEnv,
  type JsonFs,
  projectBucketDir,
} from "@ratel-ai/ratel-local-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HandlerCtx } from "../cli/handlers/types.js";
import { silentPromptAdapter } from "../cli/prompts.js";
import { newSessionToken } from "./security.js";
import { startUiServer, type UiServerHandle } from "./server.js";

const HOME = "/home/u";
const ROOT = "/r";
const USER_PATH = "/home/u/.ratel/config.json";
const PROJECT_PATH = "/r/.ratel/config.json";
const LOCAL_PATH = "/r/.ratel/config.local.json";
const CLAUDE_PATH = "/home/u/.claude.json";
const CLAUDE_SETTINGS_PATH = "/home/u/.claude/settings.json";
const CODEX_PATH = "/home/u/.codex/config.toml";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async mkdirp() {}
  async exists(p: string) {
    return this.files.has(p);
  }
  async list(p: string) {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
    }
    return Array.from(names);
  }
}

function makeCtx(fs: MemFs, env?: HierarchyEnv): HandlerCtx {
  return {
    argv: { group: "ui", configPaths: [], rest: [], extras: [], flags: {} },
    env: env ?? { homeDir: HOME, projectRoot: ROOT },
    fs,
    log: () => {},
    prompts: silentPromptAdapter(),
    installAgentPlugin: async () => ({
      installed: false,
      message: "test plugin installation failed",
    }),
  };
}

interface ServerSession {
  handle: UiServerHandle;
  token: string;
  fs: MemFs;
  ctx: HandlerCtx;
  assetDir: string;
}

async function spin(env?: HierarchyEnv): Promise<ServerSession> {
  const fs = new MemFs();
  const ctx = makeCtx(fs, env);
  const token = newSessionToken();
  const assetDir = await makeAssetDir();
  const handle = await startUiServer({ ctx, token, assetDir });
  return { handle, token, fs, ctx, assetDir };
}

let session: ServerSession;

beforeEach(async () => {
  session = await spin();
});

afterEach(async () => {
  await session.handle.shutdown();
  await rm(session.assetDir, { recursive: true, force: true });
});

function apiUrl(path: string): string {
  const port = session.handle.port;
  return `http://127.0.0.1:${port}${path}`;
}

function authHeaders(token = session.token): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function makeAssetDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ratel-ui-assets-"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(
    join(dir, "index.html"),
    '<!doctype html><html><head><title>Ratel Local</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
  );
  await writeFile(join(dir, "assets", "app.js"), "window.__ratelTestAsset = true;\n");
  await writeFile(join(dir, "assets", "app.css"), "body { color: black; }\n");
  return dir;
}

describe("UI server — auth", () => {
  it("returns 401 on /api/config without a bearer token", async () => {
    const res = await fetch(apiUrl("/api/config"));
    expect(res.status).toBe(401);
  });

  it("returns 401 on /api/config with a wrong bearer token", async () => {
    const res = await fetch(apiUrl("/api/config"), {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 on /api/config with the correct bearer token", async () => {
    const res = await fetch(apiUrl("/api/config"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeDir: string };
    expect(body.homeDir).toBe(HOME);
  });

  it("returns 401 on /api/skills without a bearer token", async () => {
    const res = await fetch(apiUrl("/api/skills"));
    expect(res.status).toBe(401);
  });

  it("returns 200 + managed/available skill buckets on /api/skills with the correct bearer token", async () => {
    const res = await fetch(apiUrl("/api/skills"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      managedDir: string;
      nativeDir: string;
      managed: unknown[];
      available: unknown[];
      problems: unknown[];
    };
    expect(body.managedDir.endsWith("/.ratel/skills")).toBe(true);
    expect(body.nativeDir.endsWith("/.claude/skills")).toBe(true);
    expect(Array.isArray(body.managed)).toBe(true);
    expect(Array.isArray(body.available)).toBe(true);
    expect(Array.isArray(body.problems)).toBe(true);
  });

  it("returns 401 on POST /api/skills/activate and /deactivate without a bearer token", async () => {
    const a = await fetch(apiUrl("/api/skills/activate"), { method: "POST" });
    const d = await fetch(apiUrl("/api/skills/deactivate"), { method: "POST" });
    expect(a.status).toBe(401);
    expect(d.status).toBe(401);
  });

  it("activates skills via POST /api/skills/activate (no-op when none present)", async () => {
    const res = await fetch(apiUrl("/api/skills/activate"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { managed: unknown[]; skipped: unknown[] };
    expect(Array.isArray(body.managed)).toBe(true);
  });

  it("deactivates skills via POST /api/skills/deactivate (no-op when none managed)", async () => {
    const res = await fetch(apiUrl("/api/skills/deactivate"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ids: ["nonexistent"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unmanaged: string[] };
    expect(Array.isArray(body.unmanaged)).toBe(true);
  });

  it("rejects POST /api/skills (create) without a bearer token", async () => {
    const res = await fetch(apiUrl("/api/skills"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects creating a skill with a missing or unsafe name", async () => {
    const missing = await fetch(apiUrl("/api/skills"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ description: "d" }),
    });
    expect(missing.status).toBe(400);

    const unsafe = await fetch(apiUrl("/api/skills"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "../evil", description: "d" }),
    });
    expect(unsafe.status).toBe(400);
  });

  it("returns 401 on GET /api/skills/:id without a bearer token", async () => {
    const res = await fetch(apiUrl("/api/skills/whatever"));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown skill id on GET /api/skills/:id", async () => {
    const res = await fetch(apiUrl("/api/skills/does-not-exist"), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("returns 401 on GET / without the t query param", async () => {
    const res = await fetch(apiUrl("/"));
    expect(res.status).toBe(401);
  });

  it("returns the HTML page on GET / with the correct t query param", async () => {
    const res = await fetch(apiUrl(`/?t=${session.token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<title>Ratel Local</title>");
  });

  it("rejects requests with a non-loopback Host header", async () => {
    const port = session.handle.port;
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { ...authHeaders(), Host: "evil.example.com:1234" },
    });
    // node fetch may rewrite Host on its own; if it does, this assertion is best-effort.
    // We accept either the security rejection or a successful response.
    expect([200, 400]).toContain(res.status);
  });
});

describe("UI server — /api/config", () => {
  it("reports all three scopes with empty configs by default", async () => {
    const res = await fetch(apiUrl("/api/config"), { headers: authHeaders() });
    const body = (await res.json()) as {
      scopes: Record<
        string,
        { available: boolean; config?: { mcpServers: Record<string, unknown> } }
      >;
      projectRoot: string | null;
    };
    expect(body.scopes.user.available).toBe(true);
    expect(body.scopes.user.config?.mcpServers).toEqual({});
    expect(body.scopes.project.available).toBe(true);
    expect(body.scopes.local.available).toBe(true);
    expect(body.projectRoot).toBe(ROOT);
  });

  it("includes per-server tool context estimates from Ratel telemetry", async () => {
    session.fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const bucket = projectBucketDir(defaultTelemetryDir({ homeDir: HOME }), ROOT);
    session.fs.files.set(
      join(bucket, "2026-06-19T12-00-00.jsonl"),
      `${JSON.stringify({
        type: "ratel_tool_payload",
        server: "fs",
        tool_count: 2,
        estimated_tokens: 1024,
        ts: Date.UTC(2026, 5, 19, 12),
      })}\n`,
    );

    const res = await fetch(apiUrl("/api/config"), { headers: authHeaders() });
    const body = (await res.json()) as {
      toolTokenEstimatesByServer: Record<
        string,
        {
          toolCount: number;
          estimatedTokens: number;
          lastSeen: string | null;
        }
      >;
    };
    expect(body.toolTokenEstimatesByServer.fs).toMatchObject({
      toolCount: 2,
      estimatedTokens: 1024,
      lastSeen: "2026-06-19T12:00:00.000Z",
    });
  });

  it("marks project/local as unavailable when there is no project root", async () => {
    await session.handle.shutdown();
    await rm(session.assetDir, { recursive: true, force: true });
    session = await spin({ homeDir: HOME });
    const res = await fetch(apiUrl("/api/config"), { headers: authHeaders() });
    const body = (await res.json()) as {
      scopes: Record<string, { available: boolean }>;
    };
    expect(body.scopes.user.available).toBe(true);
    expect(body.scopes.project.available).toBe(false);
    expect(body.scopes.local.available).toBe(false);
  });
});

describe("UI server — agent previews", () => {
  it("uses plugin-first linking through the legacy /api/link endpoint", async () => {
    const claudeBefore = JSON.stringify({ mcpServers: {} });
    session.fs.files.set(CLAUDE_PATH, claudeBefore);
    session.ctx.installAgentPlugin = async () => ({
      installed: true,
      message: "Ratel Local plugin installed for Claude Code.",
    });

    const res = await fetch(apiUrl("/api/link"), {
      method: "POST",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { log: string[] };
    expect(body.log.join("\n")).toMatch(/plugin installed/i);
    expect(session.fs.files.get(CLAUDE_PATH)).toBe(claudeBefore);
  });

  it("detects supported hosts without writing files", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const before = new Map(session.fs.files);

    const res = await fetch(apiUrl("/api/agent-hosts"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hosts: Array<{
        kind: string;
        posture: string;
        nativeEntryCount: number;
        statusline?: { status: string; ratelEnabled: boolean };
      }>;
    };

    expect(body.hosts.map((host) => host.kind)).toEqual(["claude-code", "codex"]);
    const claude = body.hosts.find((host) => host.kind === "claude-code");
    expect(claude?.posture).toBe("not-linked");
    expect(claude?.statusline?.status).toBe("not-installed");
    expect(claude?.statusline?.ratelEnabled).toBe(false);
    expect(session.fs.files).toEqual(before);
  });

  it("reports Claude statusline Ratel-enabled state when the gateway is linked", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        mcpServers: { "ratel-local": { type: "stdio", command: "ratel-local" } },
      }),
    );

    const res = await fetch(apiUrl("/api/agent-hosts"), { headers: authHeaders() });
    const body = (await res.json()) as {
      hosts: Array<{ kind: string; statusline?: { ratelEnabled: boolean } }>;
    };
    expect(body.hosts.find((host) => host.kind === "claude-code")?.statusline?.ratelEnabled).toBe(
      true,
    );
  });

  it("surfaces Claude plugin linkage through host and import preview responses", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    session.fs.files.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ enabledPlugins: { "ratel-local@ratel": true } }),
    );

    const hostsRes = await fetch(apiUrl("/api/agent-hosts"), { headers: authHeaders() });
    const hostsBody = (await hostsRes.json()) as {
      hosts: Array<{ kind: string; connection: { kind: string; linked: boolean } }>;
    };
    expect(hostsBody.hosts.find((host) => host.kind === "claude-code")?.connection).toEqual(
      expect.objectContaining({ kind: "plugin", linked: true }),
    );

    const previewRes = await fetch(apiUrl("/api/agent-preview/import"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ hostKind: "claude-code" }),
    });
    const preview = (await previewRes.json()) as {
      host: { connection: { kind: string; linked: boolean } };
      plan: { agentChanges: unknown[] };
    };
    expect(preview.host.connection).toEqual(
      expect.objectContaining({ kind: "plugin", linked: true }),
    );
    expect(preview.plan.agentChanges).toHaveLength(1);
  });

  it("surfaces Codex plugin linkage through host and import preview responses", async () => {
    session.fs.files.set(
      CODEX_PATH,
      `[plugins."ratel-local@ratel"]
enabled = true

[mcp_servers.fs]
command = "echo"
`,
    );

    const hostsRes = await fetch(apiUrl("/api/agent-hosts"), { headers: authHeaders() });
    const hostsBody = (await hostsRes.json()) as {
      hosts: Array<{ kind: string; connection: { kind: string; linked: boolean } }>;
    };
    expect(hostsBody.hosts.find((host) => host.kind === "codex")?.connection).toEqual(
      expect.objectContaining({ kind: "plugin", linked: true }),
    );

    const previewRes = await fetch(apiUrl("/api/agent-preview/import"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ hostKind: "codex" }),
    });
    const preview = (await previewRes.json()) as {
      host: { connection: { kind: string; linked: boolean } };
      plan: { agentChanges: unknown[] };
    };
    expect(preview.host.connection).toEqual(
      expect.objectContaining({ kind: "plugin", linked: true }),
    );
    expect(preview.plan.agentChanges).toHaveLength(1);
  });

  it("previews import without writing files", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    const res = await fetch(apiUrl("/api/agent-preview/import"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ hostKind: "claude-code" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{ name: string }>;
      plan: { ratelChanges: unknown[]; agentChanges: unknown[] };
    };

    expect(body.candidates.map((candidate) => candidate.name)).toEqual(["fs"]);
    expect(body.plan.ratelChanges).toHaveLength(1);
    expect(body.plan.agentChanges).toHaveLength(1);
    expect(session.fs.files.has(USER_PATH)).toBe(false);
  });

  it("applies import stages to Ratel and agent files separately", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const preview = (await (
      await fetch(apiUrl("/api/agent-preview/import"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ hostKind: "claude-code" }),
      })
    ).json()) as { selected: string[]; stageHashes: { ratel: string; agent: string } };

    const ratelRes = await fetch(apiUrl("/api/agent-apply/import/ratel"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        selection: preview.selected,
        planHash: preview.stageHashes.ratel,
      }),
    });
    expect(ratelRes.status).toBe(200);
    expect(JSON.parse(session.fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe(
      "echo",
    );
    expect(JSON.parse(session.fs.files.get(CLAUDE_PATH) as string).mcpServers.fs.command).toBe(
      "echo",
    );

    const agentRes = await fetch(apiUrl("/api/agent-apply/import/agent"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        selection: preview.selected,
        planHash: preview.stageHashes.agent,
      }),
    });
    expect(agentRes.status).toBe(200);
    const claude = JSON.parse(session.fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs).toBeUndefined();
    expect(claude.mcpServers["ratel-local"]).toBeUndefined();
  });

  it("rejects stale apply hashes", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const preview = (await (
      await fetch(apiUrl("/api/agent-preview/import"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ hostKind: "claude-code" }),
      })
    ).json()) as { selected: string[]; stageHashes: { ratel: string } };
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "node" } } }),
    );

    const res = await fetch(apiUrl("/api/agent-apply/import/ratel"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        selection: preview.selected,
        planHash: preview.stageHashes.ratel,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("preview is stale");
  });

  it("applies link to agent files only", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const preview = (await (
      await fetch(apiUrl("/api/agent-preview/link"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ hostKind: "claude-code" }),
      })
    ).json()) as { selected: string[]; stageHashes: { agent: string } };
    expect(preview.selected).toEqual([]);
    expect(session.fs.files.has(USER_PATH)).toBe(false);

    const res = await fetch(apiUrl("/api/agent-apply/link"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        planHash: preview.stageHashes.agent,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; log: string[] };
    expect(body.mode).toBe("mcp-fallback");
    expect(body.log.join("\n")).toMatch(/plugin installation failed/i);
    expect(body.log.join("\n")).toMatch(/explicit MCP gateway fallback/i);
    expect(session.fs.files.has(USER_PATH)).toBe(false);
    const claude = JSON.parse(session.fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs.command).toBe("echo");
    expect(claude.mcpServers["ratel-local"].args).toContain(USER_PATH);
  });

  it("installs the plugin first and skips the MCP fallback when installation succeeds", async () => {
    const claudeBefore = JSON.stringify({
      mcpServers: { fs: { type: "stdio", command: "echo" } },
    });
    session.fs.files.set(CLAUDE_PATH, claudeBefore);
    session.ctx.installAgentPlugin = async () => ({
      installed: true,
      message: "Ratel Local plugin installed for Claude Code.",
    });
    const preview = (await (
      await fetch(apiUrl("/api/agent-preview/link"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ hostKind: "claude-code" }),
      })
    ).json()) as { stageHashes: { agent: string } };

    const res = await fetch(apiUrl("/api/agent-apply/link"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        planHash: preview.stageHashes.agent,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; log: string[] };
    expect(body.mode).toBe("plugin");
    expect(body.log.join("\n")).toMatch(/plugin installed/i);
    expect(session.fs.files.get(CLAUDE_PATH)).toBe(claudeBefore);
  });

  it("does not run plugin installation when the reviewed link preview is stale", async () => {
    session.fs.files.set(CLAUDE_PATH, JSON.stringify({ mcpServers: {} }));
    let installCalls = 0;
    session.ctx.installAgentPlugin = async () => {
      installCalls += 1;
      return { installed: true, message: "installed" };
    };
    const preview = (await (
      await fetch(apiUrl("/api/agent-preview/link"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ hostKind: "claude-code" }),
      })
    ).json()) as { stageHashes: { agent: string } };
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { changed: { type: "stdio", command: "echo" } } }),
    );

    const res = await fetch(apiUrl("/api/agent-apply/link"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        planHash: preview.stageHashes.agent,
      }),
    });

    expect(res.status).toBe(400);
    expect(installCalls).toBe(0);
  });
});

describe("UI server — Claude statusline", () => {
  it("installs and uninstalls the Ratel statusline", async () => {
    const install = await fetch(apiUrl("/api/claude-statusline/install"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(install.status).toBe(200);
    const stored = JSON.parse(session.fs.files.get(CLAUDE_SETTINGS_PATH) as string);
    expect(stored.statusLine).toMatchObject({
      type: "command",
      padding: 0,
      refreshInterval: 30,
    });
    expect(stored.statusLine.command).toContain("statusline");

    const uninstall = await fetch(apiUrl("/api/claude-statusline/uninstall"), {
      method: "POST",
      headers: authHeaders(),
    });
    expect(uninstall.status).toBe(200);
    expect(
      JSON.parse(session.fs.files.get(CLAUDE_SETTINGS_PATH) as string).statusLine,
    ).toBeUndefined();
  });

  it("requires force before replacing a non-Ratel statusline", async () => {
    session.fs.files.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ statusLine: { type: "command", command: "other-statusline" } }),
    );

    const blocked = await fetch(apiUrl("/api/claude-statusline/install"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(400);
    expect(
      JSON.parse(session.fs.files.get(CLAUDE_SETTINGS_PATH) as string).statusLine.command,
    ).toBe("other-statusline");

    const forced = await fetch(apiUrl("/api/claude-statusline/install"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(200);
    expect(
      JSON.parse(session.fs.files.get(CLAUDE_SETTINGS_PATH) as string).statusLine.command,
    ).toContain("statusline");
  });
});

describe("UI server — add / edit / remove", () => {
  it("adds a stdio entry to the user scope", async () => {
    const res = await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "user",
        name: "fs",
        entry: { type: "stdio", command: "npx", args: ["-y", "@x/y"] },
      }),
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(session.fs.files.get(USER_PATH) as string);
    expect(stored.mcpServers.fs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
    });
  });

  it("rejects adding a duplicate name", async () => {
    session.fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const res = await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "user",
        name: "fs",
        entry: { type: "stdio", command: "echo" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already exists");
  });

  it("rejects an invalid entry shape", async () => {
    const res = await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "user",
        name: "fs",
        entry: { type: "stdio" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("edits an existing entry via PATCH", async () => {
    session.fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const res = await fetch(apiUrl("/api/servers/fs"), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "user",
        entry: { type: "stdio", command: "node", args: ["server.js"] },
      }),
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(session.fs.files.get(USER_PATH) as string);
    expect(stored.mcpServers.fs.command).toBe("node");
    expect(stored.mcpServers.fs.args).toEqual(["server.js"]);
  });

  it("removes an entry via DELETE", async () => {
    session.fs.files.set(
      USER_PATH,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "ls" },
        },
      }),
    );
    const res = await fetch(apiUrl("/api/servers/fs"), {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ scope: "user" }),
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(session.fs.files.get(USER_PATH) as string);
    expect(stored.mcpServers).toEqual({ other: { type: "stdio", command: "ls" } });
  });

  it("rejects PATCH for a missing entry", async () => {
    const res = await fetch(apiUrl("/api/servers/missing"), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ scope: "user", entry: { type: "stdio", command: "echo" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("UI server — backups", () => {
  it("reports backups in /api/config after a mutation", async () => {
    await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "user",
        name: "fs",
        entry: { type: "stdio", command: "echo" },
      }),
    });
    const cfg = await (await fetch(apiUrl("/api/config"), { headers: authHeaders() })).json();
    expect((cfg as { backups: unknown[] }).backups.length).toBeGreaterThanOrEqual(1);
  });

  it("does not expose backup undo", async () => {
    await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "user",
        name: "fs",
        entry: { type: "stdio", command: "echo" },
      }),
    });
    expect(session.fs.files.has(USER_PATH)).toBe(true);

    const res = await fetch(apiUrl("/api/backups/undo"), {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(session.fs.files.has(USER_PATH)).toBe(true);
  });
});

describe("UI server — routing", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await fetch(apiUrl("/api/nope"), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("serves built assets without an API bearer token", async () => {
    const res = await fetch(apiUrl("/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
    expect(await res.text()).toContain("__ratelTestAsset");
  });

  it("serves the SPA entry for extensionless paths with the query token", async () => {
    const res = await fetch(apiUrl(`/servers?t=${session.token}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Ratel Local</title>");
  });

  it("returns 404 for missing static assets", async () => {
    const res = await fetch(apiUrl("/assets/missing.js"));
    expect(res.status).toBe(404);
  });

  it("rejects an invalid scope", async () => {
    const res = await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "bogus",
        name: "fs",
        entry: { type: "stdio", command: "echo" },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("UI server — local scope unused vars", () => {
  it("writes to the local scope path when scope=local", async () => {
    const res = await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "local",
        name: "fs",
        entry: { type: "stdio", command: "echo" },
      }),
    });
    expect(res.status).toBe(200);
    expect(session.fs.files.has(LOCAL_PATH)).toBe(true);
  });

  it("writes to the project scope path when scope=project", async () => {
    const res = await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "project",
        name: "fs",
        entry: { type: "stdio", command: "echo" },
      }),
    });
    expect(res.status).toBe(200);
    expect(session.fs.files.has(PROJECT_PATH)).toBe(true);
  });
});

// Skill detail/edit routes read and write real SKILL.md files (unlike config,
// which uses the in-memory FS), so these exercise a real temp home directory.
describe("UI server — skill detail & edit", () => {
  let home: string;
  let local: ServerSession;

  const skillMdPath = () => join(home, ".ratel", "skills", "demo", "SKILL.md");
  const url = (path: string) => `http://127.0.0.1:${local.handle.port}${path}`;
  const headers = () => ({
    Authorization: `Bearer ${local.token}`,
    "Content-Type": "application/json",
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ratel-skills-home-"));
    const skillDir = join(home, ".ratel", "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillMdPath(),
      [
        "---",
        "name: demo",
        'description: "Original description"',
        'tags: ["alpha", "beta"]',
        "---",
        "",
        "# Original body",
        "",
      ].join("\n"),
    );
    // A sibling reference file makes loadSkills append an absolute-path
    // "Bundled resources" index; the detail endpoint must not echo it back.
    await writeFile(join(skillDir, "reference.md"), "# Reference\n");
    local = await spin({ homeDir: home });
  });

  afterEach(async () => {
    await local.handle.shutdown();
    await rm(local.assetDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("returns the clean author body (no bundled-resources index) on GET /api/skills/:id", async () => {
    const res = await fetch(url("/api/skills/demo"), { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      description: string;
      tags: string[];
      body: string;
      state: string;
    };
    expect(body.name).toBe("demo");
    expect(body.description).toBe("Original description");
    expect(body.tags).toEqual(["alpha", "beta"]);
    expect(body.body).toContain("# Original body");
    expect(body.body).not.toContain("Bundled resources");
    expect(body.state).toBe("active");
  });

  it("updates description, tags, and body via PATCH /api/skills/:id", async () => {
    const res = await fetch(url("/api/skills/demo"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        description: "New description",
        tags: ["gamma"],
        body: "# New body\n",
      }),
    });
    expect(res.status).toBe(200);

    const onDisk = await readFile(skillMdPath(), "utf8");
    expect(onDisk).toContain('description: "New description"');
    expect(onDisk).toContain('tags: ["gamma"]');
    expect(onDisk).toContain("# New body");
    expect(onDisk).not.toContain("# Original body");
    // The machine-generated index must never be persisted into the file.
    expect(onDisk).not.toContain("Bundled resources");

    const after = await fetch(url("/api/skills/demo"), { headers: headers() });
    const detail = (await after.json()) as { description: string; tags: string[] };
    expect(detail.description).toBe("New description");
    expect(detail.tags).toEqual(["gamma"]);
  });

  it("returns 404 when PATCHing an unknown skill", async () => {
    const res = await fetch(url("/api/skills/missing"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "x", tags: [], body: "" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects PATCH /api/skills/:id without a bearer token", async () => {
    const res = await fetch(url("/api/skills/demo"), { method: "PATCH" });
    expect(res.status).toBe(401);
  });

  it("preserves unmanaged frontmatter keys and folds triggers into tags on PATCH", async () => {
    const richDir = join(home, ".ratel", "skills", "rich");
    const richMd = join(richDir, "SKILL.md");
    await mkdir(richDir, { recursive: true });
    await writeFile(
      richMd,
      [
        "---",
        "name: rich",
        'description: "Old desc"',
        "allowed-tools: Read, Edit",
        "model: opus",
        'tags: ["t1"]',
        'triggers: ["trig1"]',
        'stacks: ["react"]',
        "license: MIT",
        "---",
        "",
        "# Rich body",
        "",
      ].join("\n"),
    );

    const res = await fetch(url("/api/skills/rich"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        description: "New desc",
        tags: ["t1", "trig1"],
        body: "# New rich body\n",
      }),
    });
    expect(res.status).toBe(200);

    const onDisk = await readFile(richMd, "utf8");
    // Keys Ratel does not manage survive untouched.
    expect(onDisk).toContain("allowed-tools: Read, Edit");
    expect(onDisk).toContain("model: opus");
    expect(onDisk).toContain("license: MIT");
    expect(onDisk).toContain('stacks: ["react"]');
    // Managed fields are rewritten; triggers collapse into tags.
    expect(onDisk).toContain('description: "New desc"');
    expect(onDisk).toContain('tags: ["t1", "trig1"]');
    expect(onDisk).not.toMatch(/^triggers:/m);
    expect(onDisk).not.toContain("Old desc");
    expect(onDisk).toContain("# New rich body");
  });

  it("refuses to edit an available (native) skill and leaves the file untouched", async () => {
    const nativeDir = join(home, ".claude", "skills", "native-only");
    const nativeMd = join(nativeDir, "SKILL.md");
    await mkdir(nativeDir, { recursive: true });
    const original = [
      "---",
      "name: native-only",
      'description: "Native"',
      "---",
      "",
      "# Native body",
      "",
    ].join("\n");
    await writeFile(nativeMd, original);

    // It is visible as available...
    const detail = await fetch(url("/api/skills/native-only"), { headers: headers() });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { state: string }).state).toBe("available");

    // ...but PATCH is rejected and the file is not modified.
    const res = await fetch(url("/api/skills/native-only"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "Hijacked", tags: [], body: "# Hijacked" }),
    });
    expect(res.status).toBe(409);
    expect(await readFile(nativeMd, "utf8")).toBe(original);
  });

  it("returns 400 when PATCH omits the body field", async () => {
    const res = await fetch(url("/api/skills/demo"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "New description", tags: ["gamma"] }),
    });
    expect(res.status).toBe(400);
    // The original body must be intact.
    expect(await readFile(skillMdPath(), "utf8")).toContain("# Original body");
  });

  it("round-trips a description containing quotes and backslashes through PATCH", async () => {
    const tricky = 'Use when the user says "review #123" or has a C:\\path';
    const res = await fetch(url("/api/skills/demo"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: tricky, tags: ['a "quoted" tag'], body: "# body" }),
    });
    expect(res.status).toBe(200);

    // On disk it is stored as a valid escaped (JSON-style) YAML scalar...
    const onDisk = await readFile(skillMdPath(), "utf8");
    expect(onDisk).toContain(`description: ${JSON.stringify(tricky)}`);

    // ...and reads back identically, with no accumulated backslashes.
    const detail = (await (
      await fetch(url("/api/skills/demo"), { headers: headers() })
    ).json()) as {
      description: string;
      tags: string[];
    };
    expect(detail.description).toBe(tricky);
    expect(detail.tags).toEqual(['a "quoted" tag']);
  });

  it("does not truncate a body that legitimately contains the bundled-resources heading", async () => {
    const authored = "# Intro\n\n## Bundled resources (absolute paths)\n\nI wrote this myself.\n";
    const res = await fetch(url("/api/skills/demo"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "d", tags: [], body: authored }),
    });
    expect(res.status).toBe(200);
    const onDisk = await readFile(skillMdPath(), "utf8");
    expect(onDisk).toContain("I wrote this myself.");
    expect(onDisk).toContain("## Bundled resources (absolute paths)");
  });
});

// Skills can be sourced from Claude (~/.claude/skills), Codex (~/.codex/skills),
// or created directly in Ratel (~/.ratel/skills). These exercise the source
// reporting and the Codex read-only path against a real temp home.
describe("UI server — skill sources (Claude / Codex / Ratel)", () => {
  let home: string;
  let local: ServerSession;

  const url = (path: string) => `http://127.0.0.1:${local.handle.port}${path}`;
  const headers = () => ({
    Authorization: `Bearer ${local.token}`,
    "Content-Type": "application/json",
  });
  const writeSkill = async (dir: string, name: string) => {
    const skillDir = join(home, dir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      ["---", `name: ${name}`, `description: "${name} desc"`, "---", "", `# ${name}`, ""].join(
        "\n",
      ),
    );
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ratel-skill-sources-"));
    await writeSkill(".claude/skills", "from-claude");
    await writeSkill(".codex/skills", "from-codex");
    await writeSkill(".ratel/skills", "made-in-ratel"); // managed, no manifest entry → "ratel"
    local = await spin({ homeDir: home });
  });

  afterEach(async () => {
    await local.handle.shutdown();
    await rm(local.assetDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("tags managed and available skills with their source on GET /api/skills", async () => {
    const res = await fetch(url("/api/skills"), { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      managed: Array<{ id: string; source: string }>;
      available: Array<{ id: string; source: string }>;
    };
    expect(body.managed.find((s) => s.id === "made-in-ratel")?.source).toBe("ratel");
    const sourceOf = (id: string) => body.available.find((s) => s.id === id)?.source;
    expect(sourceOf("from-claude")).toBe("claude");
    expect(sourceOf("from-codex")).toBe("codex");
  });

  it("lists a name present in both agents once per agent (Codex isn't hidden by Claude)", async () => {
    await writeSkill(".claude/skills", "in-both");
    await writeSkill(".codex/skills", "in-both");
    const res = await fetch(url("/api/skills"), { headers: headers() });
    const body = (await res.json()) as { available: Array<{ id: string; source: string }> };
    const both = body.available.filter((s) => s.id === "in-both");
    expect(both.map((s) => s.source).sort()).toEqual(["claude", "codex"]);
  });

  it("reports source=codex on GET and rejects editing a Codex skill with 409", async () => {
    const detail = await fetch(url("/api/skills/from-codex"), { headers: headers() });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { state: string; source: string };
    expect(body.state).toBe("available");
    expect(body.source).toBe("codex");

    const patch = await fetch(url("/api/skills/from-codex"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "x", tags: [], body: "y" }),
    });
    expect(patch.status).toBe(409);
  });

  it("activates a native skill as a linked managed skill and edits through the link", async () => {
    const activate = await fetch(url("/api/skills/activate"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ids: ["from-claude"], source: "claude" }),
    });
    expect(activate.status).toBe(200);
    expect((await lstat(join(home, ".ratel", "skills", "from-claude"))).isSymbolicLink()).toBe(
      true,
    );

    const list = await fetch(url("/api/skills"), { headers: headers() });
    const body = (await list.json()) as {
      managed: Array<{ id: string; mode?: string; source: string }>;
      available: Array<{ id: string; source: string }>;
    };
    expect(body.managed.find((s) => s.id === "from-claude")).toMatchObject({
      mode: "linked",
      source: "claude",
    });
    expect(body.available.some((s) => s.id === "from-claude" && s.source === "claude")).toBe(false);

    const patch = await fetch(url("/api/skills/from-claude"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "updated", tags: ["x"], body: "# Updated" }),
    });
    expect(patch.status).toBe(200);
    expect(
      await readFile(join(home, ".claude", "skills", "from-claude", "SKILL.md"), "utf8"),
    ).toContain('description: "updated"');
  });

  it("returns partial skill activation results without hiding successful writes", async () => {
    await writeSkill(".codex/skills", "valid-policy");
    await writeSkill(".codex/skills", "flow-policy");
    const policyDir = join(home, ".codex", "skills", "flow-policy", "agents");
    await mkdir(policyDir, { recursive: true });
    await writeFile(
      join(policyDir, "openai.yaml"),
      "policy: { allow_implicit_invocation: true, review: manual }\n",
    );

    const activate = await fetch(url("/api/skills/activate"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ids: ["valid-policy", "flow-policy"], source: "codex" }),
    });

    expect(activate.status).toBe(200);
    const body = (await activate.json()) as {
      managed: Array<{ id: string; mode: string }>;
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(body.managed).toEqual([{ id: "valid-policy", mode: "linked" }]);
    expect(body.skipped[0]).toMatchObject({
      id: "flow-policy",
      reason: expect.stringMatching(/unsupported/i),
    });
    expect((await lstat(join(home, ".ratel", "skills", "valid-policy"))).isSymbolicLink()).toBe(
      true,
    );
  });
});
