import { execSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { locateRatelBin, primaryRatelBin, whichRatelBin } from "./locate-bin.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

describe("locateRatelBin", () => {
  it("prefers $RATEL_LOCAL_BIN when set", async () => {
    const r = await locateRatelBin({ envVar: "/custom/bin" });
    expect(r).toEqual({ command: "/custom/bin", args: [], source: "env" });
  });

  it("treats an empty env var as unset", async () => {
    const r = await locateRatelBin({
      envVar: "",
      whichResult: "/usr/local/bin/ratel",
    });
    expect(r.source).toBe("path");
  });

  it("falls back to PATH lookup when env var unset", async () => {
    const r = await locateRatelBin({ whichResult: "/usr/local/bin/ratel" });
    expect(r).toEqual({
      command: "/usr/local/bin/ratel",
      args: [],
      source: "path",
    });
  });

  it("falls back to workspace dist/bin.js with `node` as command", async () => {
    const r = await locateRatelBin({
      workspaceRoot: "/repo",
      exists: async (p) => p === "/repo/dist/bin.js",
    });
    expect(r).toEqual({
      command: "node",
      args: ["/repo/dist/bin.js"],
      source: "workspace",
    });
  });

  it("skips the workspace branch when dist/bin.js is missing", async () => {
    let prompted = false;
    const r = await locateRatelBin({
      workspaceRoot: "/repo",
      exists: async () => false,
      promptForPath: async () => {
        prompted = true;
        return "/from/prompt/bin";
      },
    });
    expect(prompted).toBe(true);
    expect(r.source).toBe("prompt");
  });

  it("prompts when nothing else resolves and uses the prompted path", async () => {
    const r = await locateRatelBin({
      promptForPath: async () => "/asked/for/this",
    });
    expect(r).toEqual({ command: "/asked/for/this", args: [], source: "prompt" });
  });

  it("resolves a relative prompted path to absolute", async () => {
    const r = await locateRatelBin({
      promptForPath: async () => "relative/bin",
    });
    expect(r.command.startsWith("/")).toBe(true);
    expect(r.command.endsWith("relative/bin")).toBe(true);
  });

  it("throws when prompt returns empty and no other branch matched", async () => {
    await expect(locateRatelBin({ promptForPath: async () => "" })).rejects.toThrow();
  });

  it("throws when nothing is configured", async () => {
    await expect(locateRatelBin({})).rejects.toThrow();
  });
});

describe("primaryRatelBin", () => {
  it("swaps a ratel-local link for the ratel link beside it", () => {
    expect(primaryRatelBin("/usr/local/bin/ratel-local", () => true)).toBe("/usr/local/bin/ratel");
  });

  it("keeps ratel-local when no ratel sits beside it", () => {
    expect(primaryRatelBin("/usr/local/bin/ratel-local", () => false)).toBe(
      "/usr/local/bin/ratel-local",
    );
  });

  it("leaves any other path unchanged", () => {
    const isExecutable = vi.fn(() => true);
    expect(primaryRatelBin("/pkg/dist/bin.js", isExecutable)).toBe("/pkg/dist/bin.js");
    expect(isExecutable).not.toHaveBeenCalled();
  });
});

describe("whichRatelBin", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("looks up ratel-local, never a bare ratel that may be an unrelated tool", () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from("/nonexistent/bin/ratel-local\n"));
    expect(whichRatelBin()).toBe("/nonexistent/bin/ratel-local");
    expect(vi.mocked(execSync).mock.calls.map(([command]) => command)).toEqual([
      "which ratel-local",
    ]);
  });

  it("returns undefined when ratel-local is not on PATH", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("missing");
    });
    expect(whichRatelBin()).toBeUndefined();
  });
});
