import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface HookConfig {
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../plugin");
const hookConfig = JSON.parse(
  readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8"),
) as HookConfig;

describe("plugin tool-usage hooks", () => {
  it.each([
    ["Codex", "PLUGIN_ROOT"],
    ["Claude Code", "CLAUDE_PLUGIN_ROOT"],
  ])("resolves the plugin root in %s", async (_host, rootVariable) => {
    const ratelHome = await mkdtemp(join(tmpdir(), "ratel-hook-test-"));
    const command = hookConfig.hooks.PreToolUse[0].hooks[0].command;
    const result = spawnSync(command, {
      shell: true,
      input: JSON.stringify({ tool_name: "fixture_tool" }),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        RATEL_HOME: ratelHome,
        [rootVariable]: pluginRoot,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const usage = await readFile(join(ratelHome, "tool-usage/tool-usage.jsonl"), "utf8");
    expect(usage).toContain('"toolName":"fixture_tool"');
  });
});
