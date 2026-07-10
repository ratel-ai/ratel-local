import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentPromptAdapter } from "../prompts.js";
import { runSkill } from "./skill.js";
import type { HandlerCtx } from "./types.js";

// The `preload-hook` verb is a Claude Code `UserPromptSubmit` hook: Claude Code
// reads the injected context from the hook's STDOUT. ctx.log is stderr (kept
// clean for diagnostics), so the nudge JSON must be written to stdout directly.
// Regression: it once went to stderr, and the entire push path silently
// injected nothing in real Claude Code while every unit test still passed.

function hookCtx(homeDir: string, log: (m: string) => void): HandlerCtx {
  return {
    argv: {
      group: "skill",
      verb: "preload-hook",
      configPaths: [],
      rest: [],
      extras: [],
      flags: {},
    },
    env: { homeDir },
    fs: {} as unknown as HandlerCtx["fs"], // preload-hook never touches ctx.fs
    log,
    prompts: silentPromptAdapter(),
  };
}

describe("runSkill — preload-hook output stream", () => {
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");

  afterEach(() => {
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
    vi.restoreAllMocks();
  });

  it("writes the UserPromptSubmit nudge to STDOUT, not via the stderr logger", async () => {
    const home = await mkdtemp(join(tmpdir(), "ratel-hook-"));
    try {
      const skillDir = join(home, ".ratel", "skills", "frontend-react");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: frontend-react\ndescription: React UI patterns.\ntriggers: [dashboard, page, form]\nstacks: [react, next]\n---\nBODY\n",
      );
      const proj = join(home, "proj");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, "package.json"),
        JSON.stringify({ dependencies: { next: "15", react: "19" } }),
      );

      const payload = JSON.stringify({
        prompt: "build me a dashboard",
        cwd: proj,
        session_id: "t1",
      });
      Object.defineProperty(process, "stdin", {
        value: Readable.from([Buffer.from(payload)]),
        configurable: true,
      });
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderrLines: string[] = [];

      await runSkill(hookCtx(home, (m) => stderrLines.push(m)));

      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("hookSpecificOutput");
      expect(out).toContain("frontend-react");
      // The machine-read payload must NOT have gone to the stderr logger.
      expect(stderrLines.join("\n")).not.toContain("hookSpecificOutput");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
