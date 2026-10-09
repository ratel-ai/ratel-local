import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideManagedRoot } from "./managed-skills-root.js";

describe("isInsideManagedRoot", () => {
  const root = "/home/user/.ratel/skills";

  it("matches a target directly under the root", () => {
    expect(isInsideManagedRoot(join(root, "taken"), root)).toBe(true);
  });

  it("matches a nested target under the root", () => {
    expect(isInsideManagedRoot(join(root, "taken", "nested"), root)).toBe(true);
  });

  it("matches the root itself", () => {
    expect(isInsideManagedRoot(root, root)).toBe(true);
  });

  it("rejects a target outside the root", () => {
    expect(isInsideManagedRoot("/home/user/.claude/skills/taken", root)).toBe(false);
  });

  it("rejects a sibling whose path shares the root as a string prefix", () => {
    expect(isInsideManagedRoot("/home/user/.ratel/skills-alt/taken", root)).toBe(false);
  });

  it("matches a relative link target after the caller resolves it", () => {
    const linkPath = "/home/user/.claude/skills/taken";
    const absoluteTarget = resolve(dirname(linkPath), "../../.ratel/skills/taken");
    expect(isInsideManagedRoot(absoluteTarget, root)).toBe(true);
  });
});
