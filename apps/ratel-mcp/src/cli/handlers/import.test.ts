import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupFs, JsonFs, ResolvedBin } from "@ratel-ai/mcp-core";
import { describe, expect, it } from "vitest";
import { CANCEL_SYMBOL, type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import type { SkillManagePaths } from "../skills/manage.js";
import { runImport } from "./import.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/r";
const BIN: ResolvedBin = { command: "ratel-mcp", args: [], source: "path" };

const HOME_CLAUDE = "/home/u/.claude.json";
const CLAUDE_SETTINGS = "/home/u/.claude/settings.json";
const HOME_CODEX = "/home/u/.codex/config.toml";
const PROJECT_MCP = "/r/.mcp.json";
const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";
const RATEL_LOCAL = "/r/.ratel/config.local.json";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();
  failNextWriteAt: string | null = null;
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    if (this.failNextWriteAt === p) {
      this.failNextWriteAt = null;
      throw new Error(`fail-${p}`);
    }
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

function ctxOf(
  fs: MemFs,
  prompts: PromptAdapter = silentPromptAdapter(),
  withProjectRoot = true,
): { ctx: HandlerCtx; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      argv: { group: "import", configPaths: [], rest: [], extras: [], flags: {} },
      env: { homeDir: HOME, projectRoot: withProjectRoot ? ROOT : undefined },
      fs,
      log: (m) => logs.push(m),
      prompts,
    },
  };
}

async function makeSkillPaths(): Promise<SkillManagePaths & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), "ratel-import-skills-"));
  return {
    root,
    nativeDir: join(root, ".claude", "skills"),
    codexDir: join(root, ".codex", "skills"),
    managedDir: join(root, ".ratel", "skills"),
    manifestPath: join(root, ".ratel", "skill-manifest.json"),
  };
}

async function writeCliClaudeSkill(paths: SkillManagePaths, name: string): Promise<string> {
  const dir = join(paths.nativeDir, name);
  await mkdir(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: d\n---\n# body`;
  await writeFile(join(dir, "SKILL.md"), text, "utf8");
  return text;
}

async function writeMalformedClaudeSkill(paths: SkillManagePaths, name: string): Promise<void> {
  const dir = join(paths.nativeDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "# missing frontmatter", "utf8");
}

async function writeCliCodexSkill(paths: SkillManagePaths, name: string): Promise<string> {
  const dir = join(paths.codexDir, name);
  await mkdir(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: d\n---\n# body`;
  await writeFile(join(dir, "SKILL.md"), text, "utf8");
  return text;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function autoConfirm(): PromptAdapter {
  return {
    ...silentPromptAdapter(),
    async confirm() {
      return true;
    },
    async select(opts) {
      return opts.initialValue ?? opts.options[0].value;
    },
    async multiselect(opts) {
      return opts.options.map((o) => o.value) as unknown as never;
    },
    async text() {
      return "";
    },
  };
}

function selectingPrompts(selected: string[]): PromptAdapter {
  return {
    ...autoConfirm(),
    async multiselect(opts) {
      const map = new Map<string, string>();
      for (const o of opts.options) {
        const tag = o.value as string;
        const name = tag.split(":")[1] ?? tag;
        map.set(name, tag);
      }
      const tags = selected
        .map((n) => map.get(n))
        .filter((x): x is string => typeof x === "string");
      return tags as unknown as never;
    },
  };
}

function conflictStrategyPrompts(
  strategy: "add-missing-only" | "replace-selected" | "replace-from-agent" | "cancel",
  selectedConflictKeys: string[] = [],
): {
  prompts: PromptAdapter;
  conflictMessages: string[];
  selectOptions: string[];
} {
  const conflictMessages: string[] = [];
  const selectOptions: string[] = [];
  return {
    conflictMessages,
    selectOptions,
    prompts: {
      ...autoConfirm(),
      note(message, title) {
        if (title === "Ratel import conflicts") conflictMessages.push(message);
      },
      async select(opts) {
        if (opts.message.includes("Link Ratel")) return "link";
        selectOptions.splice(
          0,
          selectOptions.length,
          ...opts.options.map((o) => o.value as string),
        );
        return strategy;
      },
      async multiselect(opts) {
        if (opts.message.includes("conflicts")) {
          const available = new Set(opts.options.map((o) => o.value as string));
          return selectedConflictKeys.filter((k) => available.has(k)) as unknown as never;
        }
        return opts.options.map((o) => o.value) as unknown as never;
      },
    },
  };
}

function skippingLinkAndConfirmingImport(): PromptAdapter {
  return {
    ...autoConfirm(),
    async select(opts) {
      if (opts.message.includes("Link Ratel")) return "skip";
      return opts.initialValue ?? opts.options[0].value;
    },
  };
}

describe("runImport", () => {
  it("early-exits with a 'no MCPs found' note when nothing exists", async () => {
    const fs = new MemFs();
    const notes: string[] = [];
    const stub = { ...silentPromptAdapter(), note: (m: string) => notes.push(m) };
    const { ctx } = ctxOf(fs, stub);
    const m = await runImport(ctx, { bin: BIN });
    expect(m).toBeNull();
    expect(notes.join("\n")).toMatch(/no supported agent/i);
    expect(fs.files.size).toBe(0);
  });

  it("global-only: moves entries into Ratel global, writes ratel-mcp entry into ~/.claude.json", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, { bin: BIN, yes: true });

    expect(fs.files.has(RATEL_USER)).toBe(true);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers["ratel-mcp"]).toEqual({
      type: "stdio",
      command: "ratel-mcp",
      args: ["serve", "--config", RATEL_USER],
    });
  });

  it("shows the detected agent and MCP source paths before selection", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      PROJECT_MCP,
      JSON.stringify({
        mcpServers: { postgres: { type: "stdio", command: "pg" } },
      }),
    );
    const notes: Array<{ message: string; title: string | undefined }> = [];
    const { ctx } = ctxOf(fs, {
      ...autoConfirm(),
      note: (message, title) => notes.push({ message, title }),
    });

    await runImport(ctx, { bin: BIN, yes: true });

    const detected = notes.find((note) => note.title === "Detected agent");
    expect(detected?.message).toContain("Claude Code (claude-code)");
    expect(detected?.message).toContain(`/home/u/.claude.json (1 MCP)`);
    expect(detected?.message).toContain(`/r/.mcp.json (1 MCP)`);
  });

  it("uses the requested agent instead of the automatic choice", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { claudeOnly: { type: "stdio", command: "claude" } },
      }),
    );
    fs.files.set(
      HOME_CODEX,
      `[mcp_servers.codexOnly]
command = "codex"
`,
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, { bin: BIN, yes: true, agentKind: "codex" });

    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.codexOnly).toEqual({ type: "stdio", command: "codex" });
    expect(ratelUser.mcpServers.claudeOnly).toBeUndefined();
    expect(fs.files.get(HOME_CLAUDE)).toContain("claudeOnly");
    expect(fs.files.get(HOME_CODEX)).toContain("[mcp_servers.ratel-mcp]");
  });

  it("global+project: writes both Claude files with the right --config arg lists", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      PROJECT_MCP,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm());
    await runImport(ctx, { bin: BIN, yes: true });

    const claudeProj = JSON.parse(fs.files.get(PROJECT_MCP) as string);
    expect(claudeProj.mcpServers["ratel-mcp"].args).toEqual([
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("global+project+local: writes three Ratel entries with right chains and one merged write to ~/.claude.json", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
        projects: {
          [ROOT]: { mcpServers: { local: { type: "stdio", command: "echo" } } },
        },
      }),
    );
    fs.files.set(
      PROJECT_MCP,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm());
    await runImport(ctx, { bin: BIN, yes: true });

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers["ratel-mcp"].args).toEqual(["serve", "--config", RATEL_USER]);
    expect(claude.projects[ROOT].mcpServers["ratel-mcp"].args).toEqual([
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);
    expect(JSON.parse(fs.files.get(PROJECT_MCP) as string).mcpServers["ratel-mcp"].args).toEqual([
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("aborts cleanly when the user cancels the confirm step (no writes, no backup)", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const decline: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return false;
      },
    };
    const { ctx } = ctxOf(fs, decline, false);
    await runImport(ctx, { bin: BIN });

    // Original file untouched; no Ratel global created; no backups.
    expect(fs.files.has(RATEL_USER)).toBe(false);
    expect(JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers.fs).toBeDefined();
    const backupKeys = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupKeys).toEqual([]);
  });

  it("treats a cancel-symbol confirm as abort", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const cancelStub: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return CANCEL_SYMBOL;
      },
    };
    const { ctx } = ctxOf(fs, cancelStub, false);
    await runImport(ctx, { bin: BIN });
    expect(fs.files.has(RATEL_USER)).toBe(false);
  });

  it("reports that a completed link is retained when the import is later cancelled", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const cancellations: string[] = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      cancel(message) {
        cancellations.push(message);
      },
      async confirm() {
        return false;
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);

    await runImport(ctx, { bin: BIN });

    expect(cancellations).toEqual(["import cancelled · link retained"]);
    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers["ratel-mcp"]).toBeDefined();
    expect(claude.mcpServers.fs).toBeDefined();
  });

  it("--dry-run skips execution and logs what would be written", async () => {
    const fs = new MemFs();
    const originalClaudeConfig = JSON.stringify({
      mcpServers: { fs: { type: "stdio", command: "echo" } },
    });
    fs.files.set(HOME_CLAUDE, originalClaudeConfig);
    const { ctx, logs } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, { bin: BIN, yes: true, dryRun: true });

    expect(fs.files.has(RATEL_USER)).toBe(false);
    expect(fs.files.get(HOME_CLAUDE)).toBe(originalClaudeConfig);
    expect(Array.from(fs.files.keys()).some((path) => path.includes("/.ratel/backups/"))).toBe(
      false,
    );
    expect(logs.join("\n")).toMatch(/would link Claude Code to Ratel before importing/);
    expect(logs.join("\n")).toMatch(/would write/);
    expect(logs.join("\n")).toMatch(/\/home\/u\/\.ratel\/config\.json/);
  });

  it("--dry-run previews native skills for the requested agent without touching files", async () => {
    const fs = new MemFs();
    const skillPaths = await makeSkillPaths();
    try {
      const before = await writeCliClaudeSkill(skillPaths, "api-design");
      const { ctx, logs } = ctxOf(fs, autoConfirm(), false);

      await runImport(ctx, {
        bin: BIN,
        yes: true,
        dryRun: true,
        agentKind: "claude-code",
        skillPaths,
      });

      expect(logs.join("\n")).toMatch(/would manage skill api-design \(claude\) as invoke-only/);
      expect(await readFile(join(skillPaths.nativeDir, "api-design", "SKILL.md"), "utf8")).toBe(
        before,
      );
      expect(await pathExists(join(skillPaths.managedDir, "api-design"))).toBe(false);
      expect(await pathExists(skillPaths.manifestPath)).toBe(false);
    } finally {
      await rm(skillPaths.root, { recursive: true, force: true });
    }
  });

  it("imports MCP entries and native skills in one requested-agent flow", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const skillPaths = await makeSkillPaths();
    try {
      await writeCliClaudeSkill(skillPaths, "api-design");
      const prompts: PromptAdapter = {
        ...autoConfirm(),
        async multiselect(opts) {
          if (opts.message.includes("skills")) {
            return opts.options
              .filter((option) => String(option.value).endsWith(":api-design"))
              .map((option) => option.value) as unknown as never;
          }
          return opts.options.map((option) => option.value) as unknown as never;
        },
      };
      const { ctx } = ctxOf(fs, prompts, false);

      await runImport(ctx, {
        bin: BIN,
        agentKind: "claude-code",
        skillPaths,
        probe: async () => undefined,
      });

      const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
      expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });
      const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
      expect(claude.mcpServers["ratel-mcp"]).toEqual({
        type: "stdio",
        command: "ratel-mcp",
        args: ["serve", "--config", RATEL_USER],
      });
      expect((await lstat(join(skillPaths.managedDir, "api-design"))).isSymbolicLink()).toBe(true);
      expect(
        await readFile(join(skillPaths.nativeDir, "api-design", "SKILL.md"), "utf8"),
      ).toContain("disable-model-invocation: true");
      const manifest = JSON.parse(await readFile(skillPaths.manifestPath, "utf8"));
      expect(manifest.managed[0]).toMatchObject({
        id: "api-design",
        mode: "linked",
        source: "claude",
      });
    } finally {
      await rm(skillPaths.root, { recursive: true, force: true });
    }
  });

  it("still imports MCPs and skills after explicitly skipping the Link preflight", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const skillPaths = await makeSkillPaths();
    try {
      await writeCliClaudeSkill(skillPaths, "api-design");
      const { ctx } = ctxOf(fs, skippingLinkAndConfirmingImport(), false);

      await runImport(ctx, {
        bin: BIN,
        agentKind: "claude-code",
        skillPaths,
        probe: async () => undefined,
      });

      expect(
        JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers["ratel-mcp"],
      ).toBeUndefined();
      expect(JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers.fs).toBeUndefined();
      expect((await lstat(join(skillPaths.managedDir, "api-design"))).isSymbolicLink()).toBe(true);
      expect(
        await readFile(join(skillPaths.nativeDir, "api-design", "SKILL.md"), "utf8"),
      ).toContain("disable-model-invocation: true");
    } finally {
      await rm(skillPaths.root, { recursive: true, force: true });
    }
  });

  it("installs the Claude statusline after a skill-only import", async () => {
    const fs = new MemFs();
    const skillPaths = await makeSkillPaths();
    try {
      await writeCliClaudeSkill(skillPaths, "api-design");
      const { ctx } = ctxOf(fs, autoConfirm(), false);

      await runImport(ctx, {
        bin: BIN,
        yes: true,
        agentKind: "claude-code",
        skillPaths,
      });

      expect(JSON.parse(fs.files.get(CLAUDE_SETTINGS) as string).statusLine.command).toContain(
        "ratel-mcp statusline",
      );
    } finally {
      await rm(skillPaths.root, { recursive: true, force: true });
    }
  });

  it("offers the standalone statusline step after import and lets the user skip it", async () => {
    const fs = new MemFs();
    const skillPaths = await makeSkillPaths();
    let statuslinePrompted = false;
    try {
      await writeCliClaudeSkill(skillPaths, "api-design");
      const prompts: PromptAdapter = {
        ...autoConfirm(),
        async confirm(opts) {
          if (opts.message.includes("statusline")) {
            statuslinePrompted = true;
            return false;
          }
          return true;
        },
      };
      const { ctx } = ctxOf(fs, prompts, false);

      await runImport(ctx, {
        bin: BIN,
        agentKind: "claude-code",
        skillPaths,
      });

      expect(statuslinePrompted).toBe(true);
      expect(fs.files.has(CLAUDE_SETTINGS)).toBe(false);
    } finally {
      await rm(skillPaths.root, { recursive: true, force: true });
    }
  });

  it("keeps valid skill imports and warns when another selected skill is skipped", async () => {
    const fs = new MemFs();
    const skillPaths = await makeSkillPaths();
    try {
      await writeCliClaudeSkill(skillPaths, "valid-policy");
      await writeMalformedClaudeSkill(skillPaths, "broken-policy");
      const { ctx, logs } = ctxOf(fs, autoConfirm(), false);

      await runImport(ctx, {
        bin: BIN,
        yes: true,
        agentKind: "claude-code",
        skillPaths,
      });

      expect((await lstat(join(skillPaths.managedDir, "valid-policy"))).isSymbolicLink()).toBe(
        true,
      );
      expect(await pathExists(join(skillPaths.managedDir, "broken-policy"))).toBe(false);
      expect(logs.join("\n")).toMatch(/managing 1 skill as invoke-only/);
      expect(logs.join("\n")).toMatch(/could not manage selected skill.*broken-policy/i);
    } finally {
      await rm(skillPaths.root, { recursive: true, force: true });
    }
  });

  it("can manage Codex skills through requested-agent import without an MCP config", async () => {
    const fs = new MemFs();
    const skillPaths = await makeSkillPaths();
    try {
      await writeCliCodexSkill(skillPaths, "review-flow");
      const { ctx, logs } = ctxOf(fs, autoConfirm(), false);

      await runImport(ctx, {
        bin: BIN,
        yes: true,
        agentKind: "codex",
        skillPaths,
      });

      expect(fs.files.size).toBe(0);
      expect((await lstat(join(skillPaths.managedDir, "review-flow"))).isSymbolicLink()).toBe(true);
      expect(
        await readFile(join(skillPaths.codexDir, "review-flow", "agents", "openai.yaml"), "utf8"),
      ).toContain("allow_implicit_invocation: false");
      const manifest = JSON.parse(await readFile(skillPaths.manifestPath, "utf8"));
      expect(manifest.managed[0]).toMatchObject({
        id: "review-flow",
        mode: "linked",
        source: "codex",
      });
      expect(logs.join("\n")).toMatch(/managing 1 skill as invoke-only/);
    } finally {
      await rm(skillPaths.root, { recursive: true, force: true });
    }
  });

  it("--yes skips the confirm prompt entirely", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    let confirmCalled = false;
    const counted: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        confirmCalled = true;
        return true;
      },
    };
    const { ctx } = ctxOf(fs, counted, false);
    await runImport(ctx, { bin: BIN, yes: true });
    expect(confirmCalled).toBe(false);
    expect(fs.files.has(RATEL_USER)).toBe(true);
  });

  it("interactive conflict prompt defaults to keeping Ratel unless replace is selected", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "incoming" } },
      }),
    );
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "existing" } },
      }),
    );
    const { prompts, conflictMessages, selectOptions } =
      conflictStrategyPrompts("replace-from-agent");
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN });

    expect(conflictMessages.join("\n")).toMatch(/Claude Code definition/i);
    expect(conflictMessages.join("\n")).toMatch(/Existing Ratel definition/i);
    expect(selectOptions).toEqual(["add-missing-only", "replace-from-agent", "cancel"]);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "incoming" });
  });

  it("interactive conflict prompt can replace only selected conflicts", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "incoming-fs" },
          other: { type: "stdio", command: "incoming-other" },
        },
      }),
    );
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "existing-fs" },
          other: { type: "stdio", command: "existing-other" },
        },
      }),
    );
    const { prompts, selectOptions } = conflictStrategyPrompts("replace-selected", ["user:other"]);
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN });

    expect(selectOptions).toEqual([
      "add-missing-only",
      "replace-selected",
      "replace-from-agent",
      "cancel",
    ]);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "existing-fs" });
    expect(ratelUser.mcpServers.other).toEqual({ type: "stdio", command: "incoming-other" });
  });

  it("explicit replace-from-agent conflict strategy skips the strategy prompt", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "incoming" } },
      }),
    );
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "existing" } },
      }),
    );
    let selectCalled = false;
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      async select(opts) {
        if (opts.message.includes("Link Ratel")) return "link";
        selectCalled = true;
        return "add-missing-only";
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN, conflictStrategy: "replace-from-agent" });

    expect(selectCalled).toBe(false);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "incoming" });
  });

  it("explicit replace-selected conflict strategy still prompts for the conflicts to replace", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "incoming-fs" },
          other: { type: "stdio", command: "incoming-other" },
        },
      }),
    );
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "existing-fs" },
          other: { type: "stdio", command: "existing-other" },
        },
      }),
    );
    let selectCalled = false;
    let multiselectCalled = false;
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      async select(opts) {
        if (opts.message.includes("Link Ratel")) return "link";
        selectCalled = true;
        return "add-missing-only";
      },
      async multiselect(opts) {
        if (opts.message.includes("conflicts")) {
          multiselectCalled = true;
          return ["user:fs"] as unknown as never;
        }
        return opts.options.map((o) => o.value) as unknown as never;
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN, conflictStrategy: "replace-selected" });

    expect(selectCalled).toBe(false);
    expect(multiselectCalled).toBe(true);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "incoming-fs" });
    expect(ratelUser.mcpServers.other).toEqual({ type: "stdio", command: "existing-other" });
  });

  it("rejects replace-selected conflict strategy with --yes", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "incoming", description: "incoming fs" } },
      }),
    );
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "existing" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    await expect(
      runImport(ctx, { bin: BIN, yes: true, conflictStrategy: "replace-selected" }),
    ).rejects.toThrow(/replace-selected cannot be combined with --yes or --dry-run/);
  });

  it("rejects replace-selected conflict strategy with --dry-run", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "incoming", description: "incoming fs" } },
      }),
    );
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "existing" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    await expect(
      runImport(ctx, { bin: BIN, dryRun: true, conflictStrategy: "replace-selected" }),
    ).rejects.toThrow(/replace-selected cannot be combined with --yes or --dry-run/);
  });

  it("canceling at the conflict prompt preserves the completed Link commit without importing", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "incoming" } },
      }),
    );
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "existing" } },
      }),
    );
    const { prompts } = conflictStrategyPrompts("cancel");
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN });

    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "existing" });
    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers.fs).toBeDefined();
    expect(claude.mcpServers["ratel-mcp"]).toBeDefined();
    const backupKeys = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupKeys.length).toBeGreaterThan(0);
  });

  it("logs a backup location if executor fails mid-flight", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          "ratel-mcp": {
            type: "stdio",
            command: "ratel-mcp",
            args: ["serve", "--config", RATEL_USER],
          },
        },
      }),
    );
    fs.failNextWriteAt = HOME_CLAUDE;
    const { ctx, logs } = ctxOf(fs, autoConfirm(), false);
    await expect(runImport(ctx, { bin: BIN, yes: true })).rejects.toThrow();
    expect(logs.join("\n")).toMatch(/partial backup may exist under ~\/\.ratel\/backups\//);
    expect(logs.join("\n")).not.toMatch(/ratel-mcp backup undo/);
  });

  it("multiselect deselects an entry: only selected ones land in Ratel, deselected ones stay in Claude", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "echo-other" },
        },
      }),
    );
    const prompts = selectingPrompts(["fs"]);
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN });

    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toBeDefined();
    expect(ratelUser.mcpServers.other).toBeUndefined();

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers["ratel-mcp"]).toBeDefined();
    expect(claude.mcpServers.other).toEqual({ type: "stdio", command: "echo-other" });
    expect(claude.mcpServers.fs).toBeUndefined();
  });

  it("captures and prompts for an optional description on each selected entry without one", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      async multiselect(opts) {
        return opts.options.map((o) => o.value) as unknown as never;
      },
      async text() {
        return "filesystem stuff";
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN });
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBe("filesystem stuff");
  });

  it("always shows an upstream-instructions note (with an empty marker when none), recommends a brief description, and seeds initialValue with the preview", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          remote: { type: "http", url: "https://x" },
        },
      }),
    );
    const FS_INSTRUCTIONS = "First line of fs instructions.\nSecond paragraph here.";
    const seen: Array<{
      message: string;
      placeholder: string | undefined;
      initialValue: string | undefined;
    }> = [];
    const notes: Array<{ message: string; title: string | undefined }> = [];
    const spinnerCalls: string[] = [];
    const probeCalls: string[] = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      note(m, title) {
        notes.push({ message: m, title });
      },
      spinner() {
        return {
          start: (m?: string) => {
            spinnerCalls.push(`start:${m ?? ""}`);
          },
          stop: (m?: string) => {
            spinnerCalls.push(`stop:${m ?? ""}`);
          },
          message: () => {},
        };
      },
      async multiselect(opts) {
        return opts.options.map((o) => o.value) as unknown as never;
      },
      async text(opts) {
        seen.push({
          message: opts.message,
          placeholder: opts.placeholder,
          initialValue: opts.initialValue,
        });
        return "";
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, {
      bin: BIN,
      probe: async (name) => {
        probeCalls.push(name);
        return name === "fs" ? FS_INSTRUCTIONS : undefined;
      },
    });

    expect(probeCalls.sort()).toEqual(["fs", "remote"]);
    expect(spinnerCalls[0]).toMatch(/^start:Spinning up/);
    expect(spinnerCalls.at(-1)).toMatch(/^stop:/);

    const fsNote = notes.find((n) => n.title?.includes("fs"));
    expect(fsNote?.message).toBe(FS_INSTRUCTIONS);
    const remoteNote = notes.find((n) => n.title?.includes("remote"));
    expect(remoteNote).toBeDefined();
    expect(remoteNote?.message).toMatch(/none provided/i);

    const fsPrompt = seen.find((s) => s.message.includes(`"fs"`));
    const remotePrompt = seen.find((s) => s.message.includes(`"remote"`));
    expect(fsPrompt?.message).toMatch(/brief.*concise/i);
    expect(fsPrompt?.initialValue).toBe("First line of fs instructions.");
    expect(fsPrompt?.placeholder).toBeUndefined();
    expect(remotePrompt?.initialValue).toBe("");
    expect(remotePrompt?.placeholder).toMatch(/leave blank/i);

    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBeUndefined();
    expect(ratelUser.mcpServers.remote.description).toBeUndefined();
  });

  it("truncates a long single-line upstream instruction to a ≤120-char editable initialValue", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const long = `${"x ".repeat(200)}END`;
    const seen: Array<{ initialValue: string | undefined }> = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      async multiselect(opts) {
        return opts.options.map((o) => o.value) as unknown as never;
      },
      async text(opts) {
        seen.push({ initialValue: opts.initialValue });
        return "";
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN, probe: async () => long });

    const iv = seen[0]?.initialValue ?? "";
    expect(iv.endsWith("…")).toBe(true);
    expect(iv.length).toBeLessThanOrEqual(120);
  });

  it("does not call the probe for entries that already have a description in Claude", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo", description: "user-set" },
        },
      }),
    );
    const probeCalls: string[] = [];
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, {
      bin: BIN,
      probe: async (name) => {
        probeCalls.push(name);
        return "from upstream";
      },
    });
    expect(probeCalls).toEqual([]);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBe("user-set");
  });

  it("--yes skips probing entirely (non-interactive flow)", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const probeCalls: string[] = [];
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, {
      bin: BIN,
      yes: true,
      probe: async (name) => {
        probeCalls.push(name);
        return "should not be used";
      },
    });
    expect(probeCalls).toEqual([]);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBeUndefined();
  });

  it("re-running after a successful import produces an empty plan (idempotent)", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, { bin: BIN, yes: true });

    const filesBefore = new Map(fs.files);
    await runImport(ctx, { bin: BIN, yes: true });
    // No changes.
    expect(fs.files.size).toBe(filesBefore.size);
    for (const [k, v] of filesBefore) {
      expect(fs.files.get(k)).toBe(v);
    }
  });
});
