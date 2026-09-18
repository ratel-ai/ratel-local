import { describe, expect, it, vi } from "vitest";
import { createProgress } from "./progress.js";

describe("progress output", () => {
  it("prints only start and result outside a terminal", () => {
    const write = vi.fn();
    const spinner = vi.fn();
    const progress = createProgress({ interactive: false, write, spinner });
    progress.start("Loading");
    progress.message("50 percent");
    progress.stop("Loaded");
    progress.stop("Duplicate");
    expect(write.mock.calls).toEqual([["Loading"], ["Loaded"]]);
    expect(spinner).not.toHaveBeenCalled();
  });

  it("delegates to Clack interactively and stops before returning", () => {
    const handle = { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
    const progress = createProgress({ interactive: true, write: vi.fn(), spinner: () => handle });
    progress.start("Loading");
    progress.message("Updating");
    progress.stop("Loaded");
    expect(handle.start).toHaveBeenCalledWith("Loading");
    expect(handle.message).toHaveBeenCalledWith("Updating");
    expect(handle.stop).toHaveBeenCalledWith("Loaded");
  });
});
