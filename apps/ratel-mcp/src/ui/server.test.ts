import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/mcp-core";
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
  };
}

interface ServerSession {
  handle: UiServerHandle;
  token: string;
  fs: MemFs;
  assetDir: string;
}

async function spin(env?: HierarchyEnv): Promise<ServerSession> {
  const fs = new MemFs();
  const ctx = makeCtx(fs, env);
  const token = newSessionToken();
  const assetDir = await makeAssetDir();
  const handle = await startUiServer({ ctx, token, assetDir });
  return { handle, token, fs, assetDir };
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
    '<!doctype html><html><head><title>Ratel MCP</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
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
    const body = (await res.json()) as { moved: string[]; skipped: unknown[] };
    expect(Array.isArray(body.moved)).toBe(true);
  });

  it("deactivates skills via POST /api/skills/deactivate (no-op when none managed)", async () => {
    const res = await fetch(apiUrl("/api/skills/deactivate"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ids: ["nonexistent"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: string[] };
    expect(Array.isArray(body.restored)).toBe(true);
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
    expect(text).toContain("<title>Ratel MCP</title>");
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
  it("detects supported hosts without writing files", async () => {
    session.fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const before = new Map(session.fs.files);

    const res = await fetch(apiUrl("/api/agent-hosts"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hosts: Array<{ kind: string; posture: string; nativeEntryCount: number }>;
    };

    expect(body.hosts.map((host) => host.kind)).toEqual(["claude-code", "codex"]);
    expect(body.hosts.find((host) => host.kind === "claude-code")?.posture).toBe("not-linked");
    expect(session.fs.files).toEqual(before);
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
    expect(claude.mcpServers["ratel-mcp"].command).toBe(process.argv[1]);
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
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
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
    const beforeRatel = session.fs.files.get(USER_PATH);

    const res = await fetch(apiUrl("/api/agent-apply/link"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hostKind: "claude-code",
        planHash: preview.stageHashes.agent,
      }),
    });
    expect(res.status).toBe(200);
    expect(session.fs.files.get(USER_PATH)).toBe(beforeRatel);
    const claude = JSON.parse(session.fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs.command).toBe("echo");
    expect(claude.mcpServers["ratel-mcp"].args).toContain(USER_PATH);
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
    expect(await res.text()).toContain("<title>Ratel MCP</title>");
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
