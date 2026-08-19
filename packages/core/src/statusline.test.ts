import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BackupFs } from "./backup.js";
import { type JsonFs, nodeFs } from "./io.js";
import { createMutationEngine } from "./mutation-engine.js";
import { createPreparedChangeCoordinator } from "./prepared-change-coordinator.js";
import {
  ClaudeStatuslineConflictError,
  getClaudeCodeStatuslineState,
  installClaudeCodeStatusline,
  prepareClaudeCodeStatuslineInstall,
  prepareClaudeCodeStatuslineUninstall,
  renderRatelStatusline,
  uninstallClaudeCodeStatusline,
} from "./statusline.js";
import { defaultTelemetryDir, projectBucketDir } from "./telemetry-paths.js";

const HOME = "/home/u";
const ROOT = "/repo";
const SETTINGS = "/home/u/.claude/settings.json";
const CLAUDE_CONFIG = "/home/u/.claude.json";
const PROJECT_LOCAL_SETTINGS = "/repo/.claude/settings.local.json";

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
  return { env: { homeDir: HOME, projectRoot: ROOT }, fs, log: () => {} };
}

const bin = { command: "ratel-local", args: [], source: "path" as const };

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function claudeInput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: { display_name: "Claude Opus" },
    workspace: { project_dir: ROOT, current_dir: ROOT },
    context_window: {
      context_window_size: 200_000,
      used_percentage: 25,
      current_usage: { input_tokens: 10_000, cache_read_input_tokens: 40_000 },
    },
    cost: { total_duration_ms: 600_000 },
    worktree: { branch: "main" },
    ...overrides,
  });
}

describe("Claude Code statusline settings", () => {
  it("installs idempotently, preserves unrelated settings, and creates a backup", async () => {
    const fs = new MemFs();
    fs.files.set(SETTINGS, JSON.stringify({ theme: "dark" }));

    const first = await installClaudeCodeStatusline(ctx(fs), { bin });
    const stored = JSON.parse(fs.files.get(SETTINGS) as string);
    expect(first.changed).toBe(true);
    expect(stored.theme).toBe("dark");
    expect(stored.statusLine).toEqual({
      type: "command",
      command: "ratel-local statusline",
      padding: 0,
      refreshInterval: 30,
    });
    expect([...fs.files.keys()].some((path) => path.includes("/.ratel/backups/"))).toBe(true);

    const second = await installClaudeCodeStatusline(ctx(fs), { bin });
    expect(second.changed).toBe(false);
  });

  it("refuses to overwrite a non-Ratel statusline unless force is set", async () => {
    const fs = new MemFs();
    fs.files.set(
      SETTINGS,
      JSON.stringify({ statusLine: { type: "command", command: "other-statusline" } }),
    );

    await expect(installClaudeCodeStatusline(ctx(fs), { bin })).rejects.toThrow(
      ClaudeStatuslineConflictError,
    );
    const forced = await installClaudeCodeStatusline(ctx(fs), { bin, force: true });
    expect(forced.changed).toBe(true);
    expect(JSON.parse(fs.files.get(SETTINGS) as string).statusLine.command).toBe(
      "ratel-local statusline",
    );
  });

  it("uninstalls only Ratel-owned statuslines", async () => {
    const fs = new MemFs();
    fs.files.set(
      SETTINGS,
      JSON.stringify({ statusLine: { type: "command", command: "other-statusline" } }),
    );
    const skipped = await uninstallClaudeCodeStatusline(ctx(fs));
    expect(skipped.changed).toBe(false);
    expect(JSON.parse(fs.files.get(SETTINGS) as string).statusLine.command).toBe(
      "other-statusline",
    );

    await installClaudeCodeStatusline(ctx(fs), { bin, force: true });
    const removed = await uninstallClaudeCodeStatusline(ctx(fs));
    expect(removed.changed).toBe(true);
    expect(JSON.parse(fs.files.get(SETTINGS) as string).statusLine).toBeUndefined();
  });

  it("rejects invalid settings JSON during install and uninstall", async () => {
    const fs = new MemFs();
    fs.files.set(SETTINGS, "{bad");
    await expect(installClaudeCodeStatusline(ctx(fs), { bin })).rejects.toThrow(/Failed to parse/);
    await expect(uninstallClaudeCodeStatusline(ctx(fs))).rejects.toThrow(/Failed to parse/);
  });
});

describe("prepared Claude Code statusline changes", () => {
  it("commits install and uninstall through one-use capabilities with backups", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-statusline-prepared-"));
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      const context = { env: { homeDir }, fs: nodeFs, log: () => {} };
      const engine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
      const preparedChanges = createPreparedChangeCoordinator({ mutationEngine: engine });
      const install = await prepareClaudeCodeStatuslineInstall(context, {
        bin: { command: "ratel-local", args: [], source: "env" },
        preparedChanges,
      });
      expect(install.preview).toMatchObject({ action: "install", changed: true });
      const installed = await preparedChanges.commit(install.changeId);
      expect(installed.backupManifest).not.toBeNull();
      expect(
        JSON.parse(await readFile(join(homeDir, ".claude", "settings.json"), "utf8")),
      ).toHaveProperty("statusLine");

      const uninstall = await prepareClaudeCodeStatuslineUninstall(context, { preparedChanges });
      const removed = await preparedChanges.commit(uninstall.changeId);
      expect(removed.backupManifest).not.toBeNull();
      expect(
        JSON.parse(await readFile(join(homeDir, ".claude", "settings.json"), "utf8")),
      ).not.toHaveProperty("statusLine");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("Claude Ratel-on detection", () => {
  it("detects a linked Ratel Local entry", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_CONFIG,
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
    const state = await getClaudeCodeStatuslineState(ctx(fs));
    expect(state.ratelEnabled).toBe(true);
    expect(state.ratelEnabledSources).toContain("mcp-config");
  });

  it("detects enabled and explicitly disabled Ratel plugins", async () => {
    const fs = new MemFs();
    fs.files.set(SETTINGS, JSON.stringify({ enabledPlugins: ["ratel-local@0.3.0"] }));
    expect((await getClaudeCodeStatuslineState(ctx(fs))).ratelEnabledSources).toContain("plugin");

    fs.files.set(
      PROJECT_LOCAL_SETTINGS,
      JSON.stringify({ disabledPlugins: ["ratel-local@0.3.0"] }),
    );
    const disabled = await getClaudeCodeStatuslineState(ctx(fs));
    expect(disabled.ratelEnabled).toBe(false);
  });
});

describe("Claude statusline renderer", () => {
  it("renders full Claude JSON with new Ratel token telemetry", async () => {
    const fs = new MemFs();
    fs.files.set(
      SETTINGS,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "ratel-local statusline",
          padding: 0,
          refreshInterval: 30,
        },
        enabledPlugins: ["ratel-local@0.3.0"],
      }),
    );
    const bucket = projectBucketDir(defaultTelemetryDir({ homeDir: HOME }), ROOT);
    fs.files.set(
      join(bucket, "2026-06-19T12-00-00.jsonl"),
      `${JSON.stringify({
        type: "ratel_tool_payload",
        server: "fs",
        tool_count: 2,
        estimated_tokens: 1024,
      })}\n`,
    );

    const out = stripAnsi(await renderRatelStatusline(ctx(fs), claudeInput()));
    expect(out).toContain("Claude Opus");
    expect(out).toContain("50k / 200k · 25%");
    expect(out).toContain("10m");
    expect(out).toContain("⎇ main");
    expect(out).toContain("Ratel on");
    expect(out).toContain("saves ~1k (2 tools)");
  });

  it("falls back to old upstream_register tool counts", async () => {
    const fs = new MemFs();
    const bucket = projectBucketDir(defaultTelemetryDir({ homeDir: HOME }), ROOT);
    fs.files.set(
      join(bucket, "2026-06-19T12-00-00.jsonl"),
      `${JSON.stringify({ type: "upstream_register", server: "fs", tool_count: 3 })}\n`,
    );

    const out = stripAnsi(await renderRatelStatusline(ctx(fs), claudeInput()));
    expect(out).toContain("could trim ~390 (3 tools)");
  });

  it("handles null context and missing telemetry without throwing", async () => {
    const fs = new MemFs();
    const out = stripAnsi(
      await renderRatelStatusline(
        ctx(fs),
        claudeInput({ context_window: null, workspace: { project_dir: ROOT } }),
      ),
    );
    expect(out).toContain("context loading");
    expect(out).toContain("waiting for Ratel telemetry");
  });

  it("fails open for malformed stdin", async () => {
    const out = stripAnsi(await renderRatelStatusline(ctx(new MemFs()), "{bad"));
    expect(out).toContain("Claude statusline loading");
    expect(out).toContain("Ratel telemetry unavailable");
  });
});
