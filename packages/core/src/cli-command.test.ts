import { afterEach, describe, expect, it, vi } from "vitest";
import { isRatelGatewayEntry, makeRatelGatewayEntry } from "./gateway-entry.js";
import { whichRatelBin } from "./locate-bin.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

import { execSync } from "node:child_process";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("CLI command compatibility", () => {
  it("prefers ratel on PATH, retaining the compatibility fallback", () => {
    vi.mocked(execSync)
      .mockImplementationOnce(() => {
        throw new Error("missing");
      })
      .mockReturnValueOnce(Buffer.from("/bin/ratel-local\n"));
    expect(whichRatelBin()).toBe("/bin/ratel-local");
    expect(vi.mocked(execSync).mock.calls.map(([command]) => command)).toEqual([
      "which ratel",
      "which ratel-local",
    ]);
  });

  it("uses ratel when both names are installed", () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from("/bin/ratel\n"));
    expect(whichRatelBin()).toBe("/bin/ratel");
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith("which ratel", expect.anything());
  });

  it.each([
    "ratel",
    "ratel-local",
  ])("recognizes generated %s integrations without changing the MCP entry name", (command) => {
    const { name, entry } = makeRatelGatewayEntry({
      bin: { command, args: [], source: "path" },
      agentHost: "codex",
      linkScope: "user",
    });
    expect(name).toBe("ratel-local");
    expect(isRatelGatewayEntry(name, entry)).toBe(true);
  });
});
