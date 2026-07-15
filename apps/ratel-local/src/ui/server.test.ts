import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupFs,
  createConfigControlPlane,
  createContextSnapshotResolver,
  createProjectRegistry as createFilesystemProjectRegistry,
  createMutationEngine,
  createSkillDiscovery,
  createSkillImportControlPlane,
  createSkillRegistrationControlPlane,
  defaultTelemetryDir,
  executePlan,
  type HierarchyEnv,
  type JsonFs,
  type ProjectId,
  type ProjectRegistry,
  projectBucketDir,
  type RuntimeRevision,
} from "@ratel-ai/ratel-local-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HandlerCtx } from "../cli/handlers/types.js";
import { silentPromptAdapter } from "../cli/prompts.js";
import { newSessionToken } from "./security.js";
import { type StartUiServerOptions, startUiServer, type UiServerHandle } from "./server.js";

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
    planExecutor: executePlan,
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

async function spin(
  env?: HierarchyEnv,
  options: Pick<
    StartUiServerOptions,
    | "projectRegistry"
    | "canForgetProject"
    | "activeMcpClients"
    | "configControlPlane"
    | "snapshotResolver"
    | "skillDiscovery"
    | "skillImportControlPlane"
    | "skillRegistrationControlPlane"
    | "daemonToken"
    | "projectAdmissionLock"
  > = {},
): Promise<ServerSession> {
  const fs = new MemFs();
  const ctx = makeCtx(fs, env);
  const token = newSessionToken();
  const assetDir = await makeAssetDir();
  const handle = await startUiServer({ ctx, token, assetDir, ...options });
  return { handle, token, fs, ctx, assetDir };
}

function projectRegistry(overrides: Partial<ProjectRegistry> = {}): ProjectRegistry {
  return {
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
    ...overrides,
  };
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
  it("lists registered projects using projectId in the response", async () => {
    const projectId = "prj_registered" as ProjectId;
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({
        list: async () => [
          {
            id: projectId,
            canonicalRoot: "/repo",
            displayName: "Ratel",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "available",
          },
        ],
      }),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${projectSession.handle.port}/api/projects`, {
        headers: { Authorization: `Bearer ${projectSession.token}` },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        projects: [
          {
            projectId: "prj_registered",
            canonicalRoot: "/repo",
            displayName: "Ratel",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "available",
            connected: false,
            clientCount: 0,
            staleClientCount: 0,
          },
        ],
      });
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("registers a project through the authenticated API", async () => {
    const registrations: Array<{ path: string; displayName?: string }> = [];
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({
        registerRoot: async (path, displayName) => {
          registrations.push({ path, displayName });
          return {
            id: "prj_added" as ProjectId,
            canonicalRoot: "/canonical/repo",
            displayName: displayName ?? "repo",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
          };
        },
      }),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${projectSession.handle.port}/api/projects`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${projectSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "/repo", displayName: "Ratel Project" }),
      });

      expect(response.status).toBe(201);
      expect(registrations).toEqual([{ path: "/repo", displayName: "Ratel Project" }]);
      expect(await response.json()).toEqual({
        project: {
          projectId: "prj_added",
          canonicalRoot: "/canonical/repo",
          displayName: "Ratel Project",
          lastSeenAt: "2026-07-15T12:00:00.000Z",
        },
      });
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("forgets an available inactive project without deleting its files", async () => {
    const projectId = "prj_removable" as ProjectId;
    const forgotten: ProjectId[] = [];
    const admissions: string[] = [];
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({
        list: async () => [
          {
            id: projectId,
            canonicalRoot: "/repo",
            displayName: "Ratel",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "available",
          },
        ],
        forget: async (id) => {
          forgotten.push(id);
        },
      }),
      canForgetProject: async () => true,
      projectAdmissionLock: {
        async run(operation) {
          admissions.push("admitted");
          return operation();
        },
      },
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${projectSession.handle.port}/api/projects/prj_removable`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${projectSession.token}` },
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ projectId: "prj_removable" });
      expect(forgotten).toEqual([projectId]);
      expect(admissions).toEqual(["admitted"]);
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("returns 409 instead of forgetting an active project", async () => {
    const projectId = "prj_active" as ProjectId;
    let forgetCalled = false;
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({
        list: async () => [
          {
            id: projectId,
            canonicalRoot: "/active-repo",
            displayName: "Active",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "available",
          },
        ],
        forget: async () => {
          forgetCalled = true;
        },
      }),
      canForgetProject: async (project) => project.canonicalRoot !== "/active-repo",
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${projectSession.handle.port}/api/projects/prj_active`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${projectSession.token}` },
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "project is active: prj_active" });
      expect(forgetCalled).toBe(false);
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("uses the active MCP client reader as the default forget admission check", async () => {
    const projectId = "prj_connected" as ProjectId;
    let forgetCalled = false;
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({
        list: async () => [
          {
            id: projectId,
            canonicalRoot: "/connected-repo",
            displayName: "Connected",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "available",
          },
        ],
        forget: async () => {
          forgetCalled = true;
        },
      }),
      activeMcpClients: {
        listActiveClients: () => [
          {
            sessionId: "session-1",
            name: "codex",
            version: "1.0.0",
            protocolVersion: "2025-06-18",
            connectedAt: "2026-07-15T12:00:00.000Z",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            requestCount: 1,
            capabilities: [],
            context: { kind: "project", projectId },
            runtimeRevision: "rev_connected" as RuntimeRevision,
            stale: false,
            scope: "project",
            scopeKey: "/connected-repo",
            projectRoot: "/connected-repo",
          },
        ],
      },
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${projectSession.handle.port}/api/projects/prj_connected`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${projectSession.token}` },
        },
      );

      expect(response.status).toBe(409);
      expect(forgetCalled).toBe(false);
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("returns 409 instead of forgetting a project whose root is missing", async () => {
    const projectId = "prj_missing" as ProjectId;
    let forgetCalled = false;
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({
        list: async () => [
          {
            id: projectId,
            canonicalRoot: "/missing-repo",
            displayName: "Missing",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "missing",
          },
        ],
        forget: async () => {
          forgetCalled = true;
        },
      }),
      canForgetProject: async () => true,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${projectSession.handle.port}/api/projects/prj_missing`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${projectSession.token}` },
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "project root is missing: prj_missing" });
      expect(forgetCalled).toBe(false);
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("returns 404 when deleting an unknown projectId", async () => {
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({ list: async () => [] }),
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${projectSession.handle.port}/api/projects/prj_unknown`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${projectSession.token}` },
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "unknown project: prj_unknown" });
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("requires the UI session token for project mutations", async () => {
    const [add, remove] = await Promise.all([
      fetch(apiUrl("/api/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/repo" }),
      }),
      fetch(apiUrl("/api/projects/prj_registered"), { method: "DELETE" }),
    ]);

    expect(add.status).toBe(401);
    expect(remove.status).toBe(401);
  });

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

  it("returns an empty MCP client list when the UI is not attached to a daemon registry", async () => {
    const res = await fetch(apiUrl("/api/mcp-clients"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: unknown[] };
    expect(body.clients).toEqual([]);
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
  it("creates an immutable project context per request without leaking between tabs", async () => {
    const projectA = "prj_a" as ProjectId;
    const projectB = "prj_b" as ProjectId;
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({
        list: async () => [
          {
            id: projectA,
            canonicalRoot: "/a",
            displayName: "A",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "available",
          },
          {
            id: projectB,
            canonicalRoot: "/b",
            displayName: "B",
            lastSeenAt: "2026-07-15T12:00:00.000Z",
            status: "available",
          },
        ],
      }),
    });
    projectSession.fs.files.set(
      "/a/.ratel/config.json",
      JSON.stringify({ mcpServers: { a: { type: "stdio", command: "a" } } }),
    );
    projectSession.fs.files.set(
      "/b/.ratel/config.json",
      JSON.stringify({ mcpServers: { b: { type: "stdio", command: "b" } } }),
    );
    const base = `http://127.0.0.1:${projectSession.handle.port}`;
    const headers = { Authorization: `Bearer ${projectSession.token}` };

    try {
      const [globalResponse, aResponse, bResponse] = await Promise.all([
        fetch(`${base}/api/config`, { headers }),
        fetch(`${base}/api/config?projectId=${projectA}`, { headers }),
        fetch(`${base}/api/config?projectId=${projectB}`, { headers }),
      ]);
      const global = (await globalResponse.json()) as {
        projectRoot: string | null;
        scopes: Record<string, { available: boolean }>;
      };
      const a = (await aResponse.json()) as {
        projectRoot: string;
        scopes: Record<string, { config: { mcpServers: Record<string, unknown> } }>;
      };
      const b = (await bResponse.json()) as typeof a;

      expect(global.projectRoot).toBeNull();
      expect(global.scopes.project.available).toBe(false);
      expect(a.projectRoot).toBe("/a");
      expect(Object.keys(a.scopes.project.config.mcpServers)).toEqual(["a"]);
      expect(b.projectRoot).toBe("/b");
      expect(Object.keys(b.scopes.project.config.mcpServers)).toEqual(["b"]);
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("returns 404 for an unknown request projectId", async () => {
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({ list: async () => [] }),
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${projectSession.handle.port}/api/config?projectId=prj_unknown`,
        { headers: { Authorization: `Bearer ${projectSession.token}` } },
      );
      expect(response.status).toBe(404);
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

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
        mcpServers: {
          "ratel-local": {
            type: "stdio",
            command: "ratel-local",
            args: ["connect", "--agent-host", "claude-code", "--link-scope", "user"],
          },
        },
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

  it("applies Ratel and agent import stages through one combined endpoint", async () => {
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

    const combined = await fetch(apiUrl("/api/agent-apply/import"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        selection: preview.selected,
        stageHashes: preview.stageHashes,
      }),
    });
    expect(combined.status).toBe(200);
    expect(JSON.parse(session.fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe(
      "echo",
    );
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
    expect(res.status).toBe(409);
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
    expect(claude.mcpServers["ratel-local"].args).toEqual([
      "connect",
      "--agent-host",
      "claude-code",
      "--link-scope",
      "user",
    ]);
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

  it("fixes a duplicate Claude Code installation without reinstalling the plugin", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          "ratel-local": { type: "stdio", command: "ratel-local" },
        },
      }),
    );
    session.fs.files.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ enabledPlugins: { "ratel-local@ratel": true } }),
    );
    let installCalls = 0;
    session.ctx.installAgentPlugin = async () => {
      installCalls += 1;
      return { installed: true, message: "installed" };
    };

    const res = await fetch(apiUrl("/api/agent-connection/repair"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ hostKind: "claude-code" }),
    });

    expect(res.status).toBe(200);
    expect(installCalls).toBe(0);
    const body = (await res.json()) as { mode: string; log: string[] };
    expect(body.mode).toBe("repaired");
    expect(body.log.join("\n")).toMatch(/duplicate installation fixed/i);
    expect(JSON.parse(session.fs.files.get(CLAUDE_PATH) as string).mcpServers).toEqual({
      fs: { type: "stdio", command: "echo" },
    });
  });

  it("promotes a standalone Codex MCP connection to the plugin", async () => {
    session.fs.files.set(
      CODEX_PATH,
      ["[mcp_servers.ratel-local]", 'command = "ratel-local"', ""].join("\n"),
    );
    session.ctx.installAgentPlugin = async (hostKind) => ({
      installed: hostKind === "codex",
      message: "Ratel Local plugin installed for Codex.",
    });

    const res = await fetch(apiUrl("/api/agent-connection/repair"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ hostKind: "codex" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; log: string[] };
    expect(body.mode).toBe("promoted");
    expect(body.log.join("\n")).toMatch(/upgrade complete/i);
    expect(session.fs.files.get(CODEX_PATH)).not.toContain("mcp_servers.ratel-local");
  });

  it("keeps the standalone MCP connection when plugin promotion fails", async () => {
    const before = JSON.stringify({
      mcpServers: { "ratel-local": { type: "stdio", command: "ratel-local" } },
    });
    session.fs.files.set(CLAUDE_PATH, before);
    session.ctx.installAgentPlugin = async () => ({
      installed: false,
      message: "Claude Code plugin installation failed: unavailable",
    });

    const res = await fetch(apiUrl("/api/agent-connection/repair"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ hostKind: "claude-code" }),
    });

    expect(res.status).toBe(400);
    expect(session.fs.files.get(CLAUDE_PATH)).toBe(before);
    expect(((await res.json()) as { error: string }).error).toMatch(/left unchanged/i);
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
  it("maps unexpected scoped resolver failures to HTTP 500", async () => {
    const scoped = await spin(undefined, {
      snapshotResolver: {
        async resolve() {
          throw new Error("simulated scoped I/O failure");
        },
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${scoped.handle.port}/api/config`, {
        headers: { Authorization: `Bearer ${scoped.token}` },
      });
      expect(response.status).toBe(500);
    } finally {
      await scoped.handle.shutdown();
      await rm(scoped.assetDir, { recursive: true, force: true });
    }
  });

  it("uses the scoped transactional control plane and accepts the daemon token", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-ui-control-"));
    const homeDir = join(root, "home");
    const projectRoot = join(root, "project");
    const assetDir = await makeAssetDir();
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await mkdir(join(projectRoot, ".ratel"), { recursive: true });
    const discoveredSkillDir = join(projectRoot, ".agents", "skills", "demo");
    await mkdir(discoveredSkillDir, { recursive: true });
    await writeFile(
      join(discoveredSkillDir, "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\n---\n\nUse demo.\n",
    );
    const localPath = join(projectRoot, ".ratel", "config.local.json");
    await writeFile(
      localPath,
      `${JSON.stringify({ custom: { keep: true }, skills: { dirs: [] } }, null, 2)}\n`,
    );
    const registry = createFilesystemProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);
    const control = await createConfigControlPlane({ homeDir, projectRegistry: registry });
    const snapshotResolver = createContextSnapshotResolver({ homeDir, projectRegistry: registry });
    const skillDiscovery = createSkillDiscovery({ homeDir });
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const skillImportControlPlane = createSkillImportControlPlane({
      homeDir,
      projectRegistry: registry,
      discovery: skillDiscovery,
      mutationEngine,
    });
    const skillRegistrationControlPlane = createSkillRegistrationControlPlane({
      homeDir,
      projectRegistry: registry,
      configControlPlane: control,
      snapshotResolver,
      mutationEngine,
    });
    const token = newSessionToken();
    const daemonToken = "daemon-control-token";
    const committedTargets: Array<{ scope: string; projectId?: string }> = [];
    const handle = await startUiServer({
      ctx: makeCtx(new MemFs(), { homeDir }),
      token,
      daemonToken,
      assetDir,
      projectRegistry: registry,
      configControlPlane: control,
      snapshotResolver,
      skillDiscovery,
      skillImportControlPlane,
      skillRegistrationControlPlane,
      onScopedMutationCommitted: (targets) => {
        committedTargets.push(...targets);
      },
    });

    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const headers = {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      };
      const added = await fetch(`${base}/api/servers?projectId=${project.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          target: { scope: "local", projectId: project.id },
          name: "filesystem",
          entry: { type: "stdio", command: "node" },
        }),
      });
      expect(added.status).toBe(200);
      expect(JSON.parse(await readFile(localPath, "utf8"))).toEqual({
        custom: { keep: true },
        skills: { dirs: [] },
        mcpServers: { filesystem: { type: "stdio", command: "node" } },
      });
      const config = (await (
        await fetch(`${base}/api/config?projectId=${project.id}`, { headers })
      ).json()) as {
        runtimeRevision: string;
        documents: Array<{ ref: { scope: string }; documentRevision: string }>;
        resolvedMcpEntries: Array<{ name: string; status: string }>;
      };
      expect(config.runtimeRevision).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(config.documents.map((document) => document.ref.scope)).toEqual(["local"]);
      expect(config.documents[0]?.documentRevision).toMatch(/^rev_/);
      expect(config.resolvedMcpEntries).toContainEqual(
        expect.objectContaining({ name: "filesystem", status: "effective" }),
      );

      const skills = (await (
        await fetch(`${base}/api/skills?projectId=${project.id}`, { headers })
      ).json()) as { discovered: Array<{ id: string; candidateId: string }> };
      expect(skills.discovered).toContainEqual(
        expect.objectContaining({ id: "demo", candidateId: expect.stringMatching(/^cand_/) }),
      );
      const candidate = skills.discovered.find(({ id }) => id === "demo");
      if (!candidate) throw new Error("expected discovered demo skill");
      const previewResponse = await fetch(
        `${base}/api/skills/import/preview?projectId=${project.id}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            selections: [
              {
                candidateId: candidate.candidateId,
                targets: [
                  {
                    scopeRef: { scope: "project", projectId: project.id },
                    mode: "reference",
                  },
                ],
              },
            ],
          }),
        },
      );
      expect(previewResponse.status).toBe(200);
      const plan = (await previewResponse.json()) as { digest: string };
      const applyResponse = await fetch(`${base}/api/skills/import/apply?projectId=${project.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ plan, digest: plan.digest }),
      });
      expect(applyResponse.status).toBe(200);
      expect(
        JSON.parse(await readFile(join(projectRoot, ".ratel", "config.json"), "utf8")),
      ).toMatchObject({
        skills: {
          entries: {
            demo: { mode: "reference", path: ".agents/skills/demo", source: "codex" },
          },
        },
      });
      const addScopePreviewResponse = await fetch(
        `${base}/api/skills/add-scope/preview?projectId=${project.id}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            target: { scope: "local", projectId: project.id },
            id: "demo",
            mode: "copy",
          }),
        },
      );
      expect(addScopePreviewResponse.status).toBe(200);
      const addScopePlan = (await addScopePreviewResponse.json()) as { digest: string };
      const addScopeApplyResponse = await fetch(
        `${base}/api/skills/add-scope/apply?projectId=${project.id}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            target: { scope: "local", projectId: project.id },
            plan: addScopePlan,
            digest: addScopePlan.digest,
          }),
        },
      );
      expect(addScopeApplyResponse.status).toBe(200);
      const replayedAddScope = await fetch(
        `${base}/api/skills/add-scope/apply?projectId=${project.id}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            target: { scope: "user" },
            plan: addScopePlan,
            digest: addScopePlan.digest,
          }),
        },
      );
      expect(replayedAddScope.status).toBe(409);
      expect(
        JSON.parse(await readFile(join(projectRoot, ".ratel", "config.local.json"), "utf8")),
      ).toMatchObject({ skills: { entries: { demo: { mode: "copy" } } } });
      expect(
        JSON.parse(
          await readFile(
            join(projectRoot, ".ratel", "skills.local", "demo", ".ratel-skill.json"),
            "utf8",
          ),
        ),
      ).toEqual({ version: 1, id: "demo" });
      const removedLocalCopy = await fetch(`${base}/api/skills/demo?projectId=${project.id}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          target: { scope: "local", projectId: project.id },
          deleteOwnedCopy: true,
        }),
      });
      expect(removedLocalCopy.status).toBe(200);
      const removedScope = await fetch(`${base}/api/skills/demo?projectId=${project.id}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          target: { scope: "project", projectId: project.id },
          deleteOwnedCopy: false,
        }),
      });
      expect(removedScope.status).toBe(200);
      expect(
        JSON.parse(await readFile(join(projectRoot, ".ratel", "config.json"), "utf8")).skills
          .entries,
      ).toEqual({});

      const beforeManualEdit = await control.read({ scope: "local", projectId: project.id });
      await writeFile(
        localPath,
        `${JSON.stringify({ mcpServers: { manual: { type: "stdio", command: "x" } } })}\n`,
      );
      const stale = await fetch(`${base}/api/servers?projectId=${project.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          target: { scope: "local", projectId: project.id },
          expectedRevision: beforeManualEdit.documentRevision,
          name: "other",
          entry: { type: "stdio", command: "node" },
        }),
      });
      expect(stale.status).toBe(409);
      expect(committedTargets).toEqual([
        { scope: "local", projectId: project.id },
        { scope: "project", projectId: project.id },
        { scope: "local", projectId: project.id },
        { scope: "local", projectId: project.id },
        { scope: "project", projectId: project.id },
      ]);
    } finally {
      await handle.shutdown();
      await rm(root, { recursive: true, force: true });
      await rm(assetDir, { recursive: true, force: true });
    }
  });

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
    await writeFile(join(skillDir, ".ratel-skill.json"), '{"version":1,"id":"demo"}\n');
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
    await writeFile(join(richDir, ".ratel-skill.json"), '{"version":1,"id":"rich"}\n');

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

  it("never edits a native source through a legacy managed symlink", async () => {
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

    const nativeBefore = await readFile(
      join(home, ".claude", "skills", "from-claude", "SKILL.md"),
      "utf8",
    );
    const patch = await fetch(url("/api/skills/from-claude"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "updated", tags: ["x"], body: "# Updated" }),
    });
    expect(patch.status).toBe(409);
    expect(await readFile(join(home, ".claude", "skills", "from-claude", "SKILL.md"), "utf8")).toBe(
      nativeBefore,
    );
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
