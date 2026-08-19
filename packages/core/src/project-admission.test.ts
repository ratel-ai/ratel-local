import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectAdmissionLock } from "./project-admission.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectAdmissionLock", () => {
  it("serializes admission across independent lock instances", async () => {
    const controlDir = await mkdtemp(join(tmpdir(), "ratel-project-admission-"));
    roots.push(controlDir);
    const first = createProjectAdmissionLock({ controlDir });
    const second = createProjectAdmissionLock({ controlDir });
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const a = first.run(async () => {
      events.push("a-enter");
      await firstEntered;
      events.push("a-leave");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const b = second.run(async () => {
      events.push("b-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["a-enter"]);
    releaseFirst?.();
    await Promise.all([a, b]);
    expect(events).toEqual(["a-enter", "a-leave", "b-enter"]);
  });
});
