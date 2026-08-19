import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalGitExcludeManager,
  type LocalGitCommandExecutor,
  type LocalGitExcludeFs,
  type LocalGitExcludeValidationError,
  type LocalGitTrackedPathError,
  RATEL_LOCAL_EXCLUDE_BLOCK,
} from "./local-git-exclude.js";
import { documentRevision } from "./mutation-engine.js";

function harness(options: {
  gitPath?: string;
  tracked?: string;
  initialFiles?: Record<string, string>;
  commandError?: Error;
}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const files = new Map(Object.entries(options.initialFiles ?? {}));
  const exec: LocalGitCommandExecutor = {
    async execFile(command, args) {
      calls.push({ command, args: [...args] });
      if (options.commandError) throw options.commandError;
      if (args.includes("ls-files")) return { stdout: options.tracked ?? "" };
      if (args.includes("rev-parse"))
        return { stdout: `${options.gitPath ?? ".git/info/exclude"}\n` };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  const fs: LocalGitExcludeFs = {
    async readText(path) {
      return files.get(path) ?? null;
    },
    async writeTextAtomic(path, contents) {
      writes.push({ path, contents });
      files.set(path, contents);
    },
  };
  return { manager: createLocalGitExcludeManager({ exec, fs }), calls, writes, files };
}

describe("LocalGitExcludeManager", () => {
  it("previews the exclude edit without writing repository state", async () => {
    const path = "/repo/.git/info/exclude";
    const h = harness({ initialFiles: { [path]: "# keep\n" } });

    await expect(h.manager.preview("/repo")).resolves.toEqual({
      projectRoot: "/repo",
      excludePath: path,
      changed: true,
      currentContents: "# keep\n",
      contents: `# keep\n${RATEL_LOCAL_EXCLUDE_BLOCK}`,
      documentRevision: documentRevision("# keep\n"),
    });
    expect(h.writes).toHaveLength(0);
    expect(h.files.get(path)).toBe("# keep\n");
  });

  it("resolves a relative git-path and preserves unrelated exclude rules", async () => {
    const root = "/work/repo";
    const excludePath = posix.join(root, ".git/info/exclude");
    const h = harness({
      initialFiles: { [excludePath]: "# personal\n*.scratch\n" },
    });

    await expect(h.manager.ensure(root)).resolves.toEqual({
      projectRoot: root,
      excludePath,
      changed: true,
    });
    expect(h.files.get(excludePath)).toBe(`# personal\n*.scratch\n${RATEL_LOCAL_EXCLUDE_BLOCK}`);
    expect(h.calls).toEqual([
      {
        command: "git",
        args: ["-C", root, "ls-files", "--", ".ratel/config.local.json", ".ratel/skills.local"],
      },
      {
        command: "git",
        args: ["-C", root, "rev-parse", "--git-path", "info/exclude"],
      },
    ]);

    await expect(h.manager.ensure(root)).resolves.toMatchObject({ changed: false });
    expect(h.writes).toHaveLength(1);
  });

  it("honours an absolute git-path, as returned for linked worktrees", async () => {
    const excludePath = "/repo/.git/worktrees/topic/info/exclude";
    const h = harness({ gitPath: excludePath });

    const result = await h.manager.ensure("/tmp/topic");

    expect(result.excludePath).toBe(excludePath);
    expect(h.files.get(excludePath)).toBe(RATEL_LOCAL_EXCLUDE_BLOCK);
  });

  it("rejects tracked local artifacts without invoking git rm", async () => {
    const h = harness({
      tracked: ".ratel/config.local.json\n.ratel/skills.local/example/SKILL.md\n",
    });

    await expect(h.manager.ensure("/repo")).rejects.toEqual(
      expect.objectContaining<Partial<LocalGitTrackedPathError>>({
        statusCode: 409,
        reason: "local_paths_already_tracked",
        trackedPaths: ["/.ratel/config.local.json", "/.ratel/skills.local/example/SKILL.md"],
      }),
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls.flatMap(({ args }) => args)).not.toContain("rm");
    expect(h.writes).toHaveLength(0);
  });

  it("collapses multiple marked blocks into one while retaining other lines", async () => {
    const path = "/repo/.git/info/exclude";
    const begin = "# >>> ratel local scope >>>";
    const end = "# <<< ratel local scope <<<";
    const h = harness({
      initialFiles: {
        [path]: `${begin}\nold-rule\n${end}\nkeep-me\n${begin}\nduplicate\n${end}\n`,
      },
    });

    await h.manager.ensure("/repo");

    const updated = h.files.get(path) ?? "";
    expect(updated.match(/# >>> ratel local scope >>>/g)).toHaveLength(1);
    expect(updated).toContain("keep-me\n");
    expect(updated).not.toContain("old-rule");
    expect(updated).not.toContain("duplicate");
  });

  it("returns 422 for an unbalanced marked block instead of overwriting it", async () => {
    const path = "/repo/.git/info/exclude";
    const original = "keep\n# >>> ratel local scope >>>\nunterminated\n";
    const h = harness({ initialFiles: { [path]: original } });

    await expect(h.manager.ensure("/repo")).rejects.toEqual(
      expect.objectContaining<Partial<LocalGitExcludeValidationError>>({
        statusCode: 422,
        reason: "invalid_exclude_file",
      }),
    );
    expect(h.files.get(path)).toBe(original);
    expect(h.writes).toHaveLength(0);
  });

  it("maps git failures and empty git-path output to typed 422 errors", async () => {
    const failed = harness({ commandError: new Error("not a git repository") });
    await expect(failed.manager.ensure("/repo")).rejects.toMatchObject({
      statusCode: 422,
      reason: "git_command_failed",
    });

    const emptyPath = harness({ gitPath: "" });
    await expect(emptyPath.manager.ensure("/repo")).rejects.toMatchObject({
      statusCode: 422,
      reason: "invalid_git_path",
    });
  });
});
