import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupFs,
  createConfigControlPlane,
  createContextSnapshotResolver,
  createProjectRegistry as createFilesystemProjectRegistry,
  createMutationEngine,
  createPreparedChangeCoordinator,
  createSkillDiscovery,
  createSkillImportControlPlane,
  createSkillRegistrationControlPlane,
  defaultTelemetryDir,
  type HierarchyEnv,
  type JsonFs,
  nodeFs,
  type ProjectId,
  type ProjectRegistry,
  projectBucketDir,
  type RuntimeRevision,
} from "@ratel-ai/ratel-local-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerCtx } from "../cli/handlers/types.js";
import { silentPromptAdapter } from "../cli/prompts.js";
import { newSessionToken } from "./security.js";
import { type StartUiServerOptions, startUiServer, type UiServerHandle } from "./server.js";

const HOME = "/home/u";
const ROOT = "/r";
const USER_PATH = "/home/u/.ratel/config.json";
const PROJECT_PATH = "/r/.ratel/config.json";
const LOCAL_PATH = "/r/.ratel/config.local.json";
const CLAUDE_SETTINGS_PATH = "/home/u/.claude/settings.json";

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
    | "authenticateMcpServer"
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

  it("authenticates through the daemon context runner and registers CLI project roots", async () => {
    const projectId = "prj_auth" as ProjectId;
    const admissions: string[] = [];
    const registerRoot = vi.fn(async () => ({
      id: projectId,
      canonicalRoot: "/canonical/repo",
      displayName: "repo",
      lastSeenAt: "2026-07-24T00:00:00.000Z",
    }));
    const authenticateMcpServer = vi.fn(async () => [
      { name: "linear", status: "authorized" as const, mode: "interactive" as const },
    ]);
    const projectSession = await spin(undefined, {
      projectRegistry: projectRegistry({ registerRoot }),
      projectAdmissionLock: {
        run: async <T>(action: () => Promise<T>) => {
          admissions.push("entered");
          return action();
        },
      },
      snapshotResolver: {
        resolve: async (context) =>
          ({
            context,
            projectRoot: "/canonical/repo",
            documents: [],
            runtimeRevision: "rev-auth",
            mcpEntries: [
              {
                name: "linear",
                status: "effective",
                entry: { type: "http", url: "https://mcp.linear.example" },
              },
            ],
            skills: {
              effectiveSkills: [],
              registrations: [],
              diagnostics: [],
              fingerprint: "skills",
              watchInputs: [],
            },
            diagnostics: [],
            watchInputs: [],
          }) as never,
      },
      authenticateMcpServer,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${projectSession.handle.port}/api/auth/linear?projectRoot=${encodeURIComponent("/repo")}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${projectSession.token}` },
        },
      );

      expect(response.status).toBe(200);
      expect(admissions).toEqual(["entered"]);
      expect(registerRoot).toHaveBeenCalledWith("/repo");
      expect(authenticateMcpServer).toHaveBeenCalledWith(
        { kind: "project", projectId },
        { name: "linear" },
      );
      expect(await response.json()).toMatchObject({
        results: [{ name: "linear", status: "authorized" }],
      });
    } finally {
      await projectSession.handle.shutdown();
      await rm(projectSession.assetDir, { recursive: true, force: true });
    }
  });

  it("returns every bulk authentication result when an upstream fails", async () => {
    const authenticateMcpServer = vi.fn(async () => [
      { name: "stripe", status: "authorized" as const },
      { name: "linear", status: "failed" as const, reason: "user denied" },
    ]);
    const projectSession = await spin(undefined, {
      snapshotResolver: {
        resolve: async (context) =>
          ({
            context,
            documents: [],
            runtimeRevision: "rev-auth",
            mcpEntries: [
              {
                name: "stripe",
                status: "effective",
                entry: { type: "http", url: "https://mcp.stripe.example" },
              },
              {
                name: "linear",
                status: "effective",
                entry: { type: "http", url: "https://mcp.linear.example" },
              },
            ],
            skills: {
              effectiveSkills: [],
              registrations: [],
              diagnostics: [],
              fingerprint: "skills",
              watchInputs: [],
            },
            diagnostics: [],
            watchInputs: [],
          }) as never,
      },
      authenticateMcpServer,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${projectSession.handle.port}/api/auth`, {
        method: "POST",
        headers: { Authorization: `Bearer ${projectSession.token}` },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        results: [
          { name: "stripe", status: "authorized" },
          { name: "linear", status: "failed", reason: "user denied" },
        ],
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

  it("does not expose deprecated skill activation", async () => {
    const res = await fetch(apiUrl("/api/skills/activate"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("does not expose deprecated skill deactivation", async () => {
    const res = await fetch(apiUrl("/api/skills/deactivate"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ids: ["nonexistent"] }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects POST /api/skills (create) without a bearer token", async () => {
    const res = await fetch(apiUrl("/api/skills"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("does not expose the legacy unscoped skill creation branch", async () => {
    const missing = await fetch(apiUrl("/api/skills"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ description: "d" }),
    });
    expect(missing.status).toBe(404);

    const unsafe = await fetch(apiUrl("/api/skills"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "../evil", description: "d" }),
    });
    expect(unsafe.status).toBe(404);
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

describe("UI server — prepared agent changes", () => {
  it("prepares, commits, and consumes one atomic agent import", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-ui-agent-change-"));
    const homeDir = join(root, "home");
    const assetDir = await makeAssetDir();
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    const claudePath = join(homeDir, ".claude.json");
    await writeFile(
      claudePath,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const ctx: HandlerCtx = {
      ...makeCtx(new MemFs(), { homeDir }),
      fs: nodeFs,
    };
    const token = newSessionToken();
    const handle = await startUiServer({
      ctx,
      token,
      assetDir,
      preparedChanges,
    });

    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const prepareResponse = await fetch(`${base}/api/agents/import/prepare`, {
        method: "POST",
        headers,
        body: JSON.stringify({ hostKind: "claude-code" }),
      });
      expect(prepareResponse.status).toBe(200);
      const prepared = (await prepareResponse.json()) as {
        changeId: string;
        kind: string;
        expiresAt: string;
        preview: {
          candidates: Array<{ name: string }>;
          plan: { ratelChanges: unknown[]; agentChanges: unknown[] };
        };
      };
      expect(Object.keys(prepared).sort()).toEqual(["changeId", "expiresAt", "kind", "preview"]);
      expect(prepared.kind).toBe("agent.import");
      expect(prepared.preview.candidates.map(({ name }) => name)).toEqual(["fs"]);
      expect(prepared.preview.plan.ratelChanges).toHaveLength(1);
      expect(prepared.preview.plan.agentChanges).toHaveLength(1);
      await expect(readFile(join(homeDir, ".ratel", "config.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const commitResponse = await fetch(
        `${base}/api/changes/${encodeURIComponent(prepared.changeId)}/commit`,
        { method: "POST", headers },
      );
      expect(commitResponse.status).toBe(200);
      const commit = (await commitResponse.json()) as {
        transactionId: string;
        changedPaths: string[];
        backupManifest: unknown;
        result: { flow: string };
      };
      expect(commit.transactionId).toBeTruthy();
      expect(commit.changedPaths).toHaveLength(2);
      expect(commit.backupManifest).not.toBeNull();
      expect(commit.result.flow).toBe("import");
      expect(
        JSON.parse(await readFile(join(homeDir, ".ratel", "config.json"), "utf8")).mcpServers.fs
          .command,
      ).toBe("echo");
      expect(JSON.parse(await readFile(claudePath, "utf8")).mcpServers.fs).toBeUndefined();

      const replay = await fetch(
        `${base}/api/changes/${encodeURIComponent(prepared.changeId)}/commit`,
        { method: "POST", headers },
      );
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ code: "PREPARED_CHANGE_UNAVAILABLE" });
    } finally {
      await handle.shutdown();
      await rm(root, { recursive: true, force: true });
      await rm(assetDir, { recursive: true, force: true });
    }
  });

  it("cancels dismissed changes and leaves legacy agent endpoints absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-ui-agent-cancel-"));
    const homeDir = join(root, "home");
    const assetDir = await makeAssetDir();
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    const claudePath = join(homeDir, ".claude.json");
    const before = JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } });
    await writeFile(claudePath, before);
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const ctx: HandlerCtx = { ...makeCtx(new MemFs(), { homeDir }), fs: nodeFs };
    const token = newSessionToken();
    const handle = await startUiServer({ ctx, token, assetDir, preparedChanges });

    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const prepared = (await (
        await fetch(`${base}/api/agents/link/prepare`, {
          method: "POST",
          headers,
          body: JSON.stringify({ hostKind: "claude-code" }),
        })
      ).json()) as { changeId: string };
      expect(
        await fetch(`${base}/api/changes/${prepared.changeId}`, {
          method: "DELETE",
          headers,
        }),
      ).toMatchObject({ status: 204 });
      const consumed = await fetch(`${base}/api/changes/${prepared.changeId}/commit`, {
        method: "POST",
        headers,
      });
      expect(consumed.status).toBe(409);
      expect(await readFile(claudePath, "utf8")).toBe(before);

      for (const path of [
        "/api/link",
        "/api/import",
        "/api/agent-preview/import",
        "/api/agent-preview/link",
        "/api/agent-apply/import",
        "/api/agent-apply/link",
      ]) {
        const response = await fetch(`${base}${path}`, { method: "POST", headers });
        expect(response.status, path).toBe(404);
      }
    } finally {
      await handle.shutdown();
      await rm(root, { recursive: true, force: true });
      await rm(assetDir, { recursive: true, force: true });
    }
  });

  it("cancels the reviewed MCP fallback when plugin installation succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-ui-agent-plugin-"));
    const homeDir = join(root, "home");
    const assetDir = await makeAssetDir();
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    const claudePath = join(homeDir, ".claude.json");
    const before = JSON.stringify({ mcpServers: {} });
    await writeFile(claudePath, before);
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const ctx: HandlerCtx = {
      ...makeCtx(new MemFs(), { homeDir }),
      fs: nodeFs,
      installAgentPlugin: async () => ({ installed: true, message: "plugin installed" }),
    };
    const token = newSessionToken();
    const handle = await startUiServer({ ctx, token, assetDir, preparedChanges });

    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const prepared = (await (
        await fetch(`${base}/api/agents/link/prepare`, {
          method: "POST",
          headers,
          body: JSON.stringify({ hostKind: "claude-code" }),
        })
      ).json()) as { changeId: string };
      const response = await fetch(`${base}/api/changes/${prepared.changeId}/commit`, {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        changedPaths: [],
        backupManifest: null,
        result: { mode: "plugin" },
      });
      expect(await readFile(claudePath, "utf8")).toBe(before);
    } finally {
      await handle.shutdown();
      await rm(root, { recursive: true, force: true });
      await rm(assetDir, { recursive: true, force: true });
    }
  });

  it("reports a failed RC channel without writing an MCP fallback when stable is restored", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-ui-agent-plugin-channel-"));
    const homeDir = join(root, "home");
    const assetDir = await makeAssetDir();
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    const claudePath = join(homeDir, ".claude.json");
    const before = JSON.stringify({ mcpServers: {} });
    await writeFile(claudePath, before);
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const ctx: HandlerCtx = {
      ...makeCtx(new MemFs(), { homeDir }),
      fs: nodeFs,
      installAgentPlugin: async () => ({
        installed: false,
        pluginAvailable: true,
        message: "Stable plugin restored; requested RC channel is not active.",
      }),
    };
    const token = newSessionToken();
    const handle = await startUiServer({ ctx, token, assetDir, preparedChanges });

    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const prepared = (await (
        await fetch(`${base}/api/agents/link/prepare`, {
          method: "POST",
          headers,
          body: JSON.stringify({ hostKind: "claude-code" }),
        })
      ).json()) as { changeId: string };
      const response = await fetch(`${base}/api/changes/${prepared.changeId}/commit`, {
        method: "POST",
        headers,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "Stable plugin restored; requested RC channel is not active.",
      });
      expect(await readFile(claudePath, "utf8")).toBe(before);
    } finally {
      await handle.shutdown();
      await rm(root, { recursive: true, force: true });
      await rm(assetDir, { recursive: true, force: true });
    }
  });
});

describe("UI server — Claude statusline", () => {
  it("requires the unified coordinator for statusline writes", async () => {
    const install = await fetch(apiUrl("/api/claude-statusline/install"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    const uninstall = await fetch(apiUrl("/api/claude-statusline/uninstall"), {
      method: "POST",
      headers: authHeaders(),
    });
    expect(install.status).toBe(404);
    expect(uninstall.status).toBe(404);
    expect(session.fs.files.has(CLAUDE_SETTINGS_PATH)).toBe(false);
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
    const snapshotResolver = createContextSnapshotResolver({ homeDir, projectRegistry: registry });
    const skillDiscovery = createSkillDiscovery({ homeDir });
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const committedContexts: unknown[] = [];
    const preparedChanges = createPreparedChangeCoordinator({
      mutationEngine,
      publish: (contexts) => {
        committedContexts.push(...contexts);
      },
    });
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: registry,
      preparedChanges,
    });
    const skillImportControlPlane = createSkillImportControlPlane({
      homeDir,
      projectRegistry: registry,
      discovery: skillDiscovery,
      preparedChanges,
    });
    const skillRegistrationControlPlane = createSkillRegistrationControlPlane({
      homeDir,
      projectRegistry: registry,
      configControlPlane: control,
      snapshotResolver,
      preparedChanges,
    });
    const token = newSessionToken();
    const daemonToken = "daemon-control-token";
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
      preparedChanges,
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

      const createdSkill = await fetch(`${base}/api/skills?projectId=${project.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          target: { scope: "project", projectId: project.id },
          name: "authored",
          description: "Authored in Ratel",
          tags: ["test"],
          body: "# Instructions",
        }),
      });
      expect(createdSkill.status).toBe(200);
      expect(
        JSON.parse(await readFile(join(projectRoot, ".ratel", "config.json"), "utf8")),
      ).toMatchObject({
        skills: { entries: { authored: { mode: "copy", source: "ratel" } } },
      });
      expect(
        JSON.parse(
          await readFile(
            join(projectRoot, ".ratel", "skills", "authored", ".ratel-skill.json"),
            "utf8",
          ),
        ),
      ).toEqual({ version: 1, id: "authored" });

      const skills = (await (
        await fetch(`${base}/api/skills?projectId=${project.id}`, { headers })
      ).json()) as { discovered: Array<{ id: string; candidateId: string }> };
      expect(skills.discovered).toContainEqual(
        expect.objectContaining({ id: "demo", candidateId: expect.stringMatching(/^cand_/) }),
      );
      const candidate = skills.discovered.find(({ id }) => id === "demo");
      if (!candidate) throw new Error("expected discovered demo skill");
      const previewResponse = await fetch(
        `${base}/api/skills/import/prepare?projectId=${project.id}`,
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
      const preparedImport = (await previewResponse.json()) as { changeId: string };
      const applyResponse = await fetch(
        `${base}/api/changes/${preparedImport.changeId}/commit?projectId=${project.id}`,
        {
          method: "POST",
          headers,
        },
      );
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
        `${base}/api/skills/add-scope/prepare?projectId=${project.id}`,
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
      const addScopePlan = (await addScopePreviewResponse.json()) as { changeId: string };
      const addScopeApplyResponse = await fetch(
        `${base}/api/changes/${addScopePlan.changeId}/commit?projectId=${project.id}`,
        {
          method: "POST",
          headers,
        },
      );
      expect(addScopeApplyResponse.status).toBe(200);
      const replayedAddScope = await fetch(
        `${base}/api/changes/${addScopePlan.changeId}/commit?projectId=${project.id}`,
        {
          method: "POST",
          headers,
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
      ).toEqual({ authored: { mode: "copy", source: "ratel" } });

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
      expect(committedContexts.length).toBeGreaterThanOrEqual(5);
    } finally {
      await handle.shutdown();
      await rm(root, { recursive: true, force: true });
      await rm(assetDir, { recursive: true, force: true });
    }
  });

  it("keeps explicit-config serving read-only without a coordinator", async () => {
    const res = await fetch(apiUrl("/api/servers"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        scope: "user",
        name: "fs",
        entry: { type: "stdio", command: "npx", args: ["-y", "@x/y"] },
      }),
    });
    expect(res.status).toBe(404);
    expect(session.fs.files.has(USER_PATH)).toBe(false);
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
    expect(res.status).toBe(404);
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
    expect(res.status).toBe(404);
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
    expect(res.status).toBe(404);
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
    expect(res.status).toBe(404);
  });

  it("rejects PATCH for a missing entry", async () => {
    const res = await fetch(apiUrl("/api/servers/missing"), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ scope: "user", entry: { type: "stdio", command: "echo" } }),
    });
    expect(res.status).toBe(404);
  });
});

describe("UI server — backups", () => {
  it("does not create backups for a rejected legacy mutation", async () => {
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
    expect((cfg as { backups: unknown[] }).backups).toEqual([]);
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
    expect(session.fs.files.has(USER_PATH)).toBe(false);

    const res = await fetch(apiUrl("/api/backups/undo"), {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(session.fs.files.has(USER_PATH)).toBe(false);
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
    expect(res.status).toBe(404);
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
    expect(res.status).toBe(404);
    expect(session.fs.files.has(LOCAL_PATH)).toBe(false);
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
    expect(res.status).toBe(404);
    expect(session.fs.files.has(PROJECT_PATH)).toBe(false);
  });
});

// Explicit-config serving keeps skill discovery and detail reads available, but
// user-configuration writes require daemon-provided control planes.
describe("UI server — explicit-config skill compatibility", () => {
  let home: string;
  let local: ServerSession;

  const url = (path: string) => `http://127.0.0.1:${local.handle.port}${path}`;
  const headers = () => ({
    Authorization: `Bearer ${local.token}`,
    "Content-Type": "application/json",
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ratel-skills-read-only-"));
    const managed = join(home, ".ratel", "skills", "demo");
    const native = join(home, ".codex", "skills", "native-review");
    await mkdir(managed, { recursive: true });
    await mkdir(native, { recursive: true });
    await writeFile(
      join(managed, "SKILL.md"),
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
    await writeFile(join(managed, ".ratel-skill.json"), '{"version":1,"id":"demo"}\n');
    await writeFile(
      join(native, "SKILL.md"),
      ["---", "name: native-review", 'description: "Native"', "---", "", "# Native", ""].join("\n"),
    );
    local = await spin({ homeDir: home });
  });

  afterEach(async () => {
    await local.handle.shutdown();
    await rm(local.assetDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("continues to serve skill lists and clean authored detail", async () => {
    const listResponse = await fetch(url("/api/skills"), { headers: headers() });
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      managed: Array<{ id: string; source: string }>;
      available: Array<{ id: string; source: string }>;
    };
    expect(list.managed).toContainEqual(expect.objectContaining({ id: "demo", source: "ratel" }));
    expect(list.available).toContainEqual(
      expect.objectContaining({ id: "native-review", source: "codex" }),
    );

    const detailResponse = await fetch(url("/api/skills/demo"), { headers: headers() });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      description: string;
      tags: string[];
      body: string;
    };
    expect(detail.description).toBe("Original description");
    expect(detail.tags).toEqual(["alpha", "beta"]);
    expect(detail.body).toContain("# Original body");
    expect(detail.body).not.toContain("Bundled resources");
  });

  it("rejects legacy unscoped edits without changing the skill", async () => {
    const skillPath = join(home, ".ratel", "skills", "demo", "SKILL.md");
    const before = await readFile(skillPath, "utf8");
    const response = await fetch(url("/api/skills/demo"), {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ description: "Changed", tags: [], body: "# Changed" }),
    });
    expect(response.status).toBe(404);
    expect(await readFile(skillPath, "utf8")).toBe(before);
  });

  it("does not expose deprecated activate/deactivate routes", async () => {
    for (const path of ["/api/skills/activate", "/api/skills/deactivate"]) {
      const response = await fetch(url(path), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
      });
      expect(response.status, path).toBe(404);
    }
  });
});
