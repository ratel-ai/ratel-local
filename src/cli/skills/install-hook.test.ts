import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BackupFs } from "../backup.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { JsonFs } from "../io.js";
import {
  addPreloadHook,
  installHook,
  preloadHookCommand,
  removePreloadHook,
  settingsPathForScope,
  uninstallHook,
} from "./install-hook.js";

const COMMAND = "ratel-mcp skill preload-hook";

function memFs(): (JsonFs & BackupFs) & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(p) {
      return files.has(p) ? (files.get(p) as string) : null;
    },
    async writeAtomic(p, c) {
      files.set(p, c);
    },
    async exists(p) {
      return files.has(p);
    },
    async write(p, c) {
      files.set(p, c);
    },
    async remove(p) {
      files.delete(p);
    },
    async mkdirp() {},
    async list() {
      return [];
    },
  };
}

const env: HierarchyEnv = { homeDir: "/home" };
const deps = (fs: JsonFs & BackupFs) => ({ fs, env, now: () => new Date("2026-06-08T00:00:00Z") });

describe("settingsPathForScope / preloadHookCommand", () => {
  it("resolves the user settings path", () => {
    expect(settingsPathForScope("user", env)).toBe(join("/home", ".claude", "settings.json"));
  });

  it("renders the hook command from a resolved bin", () => {
    expect(preloadHookCommand({ command: "node", args: ["/x/bin.js"], source: "workspace" })).toBe(
      "node /x/bin.js skill preload-hook",
    );
  });
});

describe("addPreloadHook / removePreloadHook (pure)", () => {
  it("adds a UserPromptSubmit command entry", () => {
    const out = addPreloadHook({}, COMMAND);
    const matchers = (
      out.hooks as { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> }
    ).UserPromptSubmit;
    expect(matchers[0].hooks[0].command).toBe(COMMAND);
  });

  it("is idempotent — adding twice returns the same reference", () => {
    const once = addPreloadHook({}, COMMAND);
    expect(addPreloadHook(once, COMMAND)).toBe(once);
  });

  it("preserves unrelated existing UserPromptSubmit hooks", () => {
    const existing = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    };
    const out = addPreloadHook(existing, COMMAND);
    const list = (out.hooks as { UserPromptSubmit: unknown[] }).UserPromptSubmit;
    expect(list).toHaveLength(2);
  });

  it("removes only our entry, leaving others", () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "other-tool" }] },
          { hooks: [{ type: "command", command: COMMAND }] },
        ],
      },
    };
    const out = removePreloadHook(settings);
    const list = (out.hooks as { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> })
      .UserPromptSubmit;
    expect(list).toHaveLength(1);
    expect(list[0].hooks[0].command).toBe("other-tool");
  });

  it("removePreloadHook is a no-op (same reference) when nothing matches", () => {
    const settings = { hooks: { UserPromptSubmit: [] } };
    expect(removePreloadHook(settings)).toBe(settings);
  });
});

describe("installHook / uninstallHook (fs)", () => {
  const path = settingsPathForScope("user", env);

  it("writes the hook, backs up the file, and is idempotent", async () => {
    const fs = memFs();
    const first = await installHook(path, COMMAND, deps(fs));
    expect(first.changed).toBe(true);
    expect(fs.files.get(path)).toContain(COMMAND);
    // a backup manifest was written under ~/.ratel/backups/...
    expect(
      [...fs.files.keys()].some((k) => k.includes("backups") && k.endsWith("manifest.json")),
    ).toBe(true);

    const second = await installHook(path, COMMAND, deps(fs));
    expect(second.changed).toBe(false);
  });

  it("uninstall removes the hook; no-op when absent", async () => {
    const fs = memFs();
    await installHook(path, COMMAND, deps(fs));
    const removed = await uninstallHook(path, deps(fs));
    expect(removed.changed).toBe(true);
    expect(fs.files.get(path) ?? "").not.toContain(COMMAND);

    const again = await uninstallHook(path, deps(fs));
    expect(again.changed).toBe(false);
  });
});
