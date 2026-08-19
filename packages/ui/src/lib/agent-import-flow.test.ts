import { describe, expect, it, vi } from "vitest";
import { importStatuslineAction, linkThenRefreshImportPreview } from "./agent-import-flow";

describe("linkThenRefreshImportPreview", () => {
  it("loads a fresh import preview after linking succeeds", async () => {
    const order: string[] = [];
    const link = vi.fn(async () => {
      order.push("link");
      return true;
    });
    const loadImportPreview = vi.fn(async () => {
      order.push("preview");
      return { changeId: "fresh" };
    });

    await expect(linkThenRefreshImportPreview(link, loadImportPreview)).resolves.toEqual({
      changeId: "fresh",
    });
    expect(order).toEqual(["link", "preview"]);
  });

  it("does not load a preview when linking fails", async () => {
    const loadImportPreview = vi.fn(async () => ({ changeId: "unused" }));

    await expect(
      linkThenRefreshImportPreview(async () => false, loadImportPreview),
    ).resolves.toBeNull();
    expect(loadImportPreview).not.toHaveBeenCalled();
  });
});

describe("importStatuslineAction", () => {
  it("makes replacing a non-Ratel statusline explicit", () => {
    expect(importStatuslineAction("other")).toEqual({
      actionLabel: "Replace statusline",
      description:
        "Import is complete. Replace the existing non-Ratel Claude Code statusline with the standalone Ratel statusline?",
      force: true,
      title: "Replace the existing statusline?",
    });
  });
});
