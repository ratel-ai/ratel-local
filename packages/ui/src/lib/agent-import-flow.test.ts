import { describe, expect, it, vi } from "vitest";
import { linkThenRefreshImportPreview } from "./agent-import-flow";

describe("linkThenRefreshImportPreview", () => {
  it("loads a fresh import preview after linking succeeds", async () => {
    const order: string[] = [];
    const link = vi.fn(async () => {
      order.push("link");
      return true;
    });
    const loadImportPreview = vi.fn(async () => {
      order.push("preview");
      return { stageHashes: { agent: "fresh" } };
    });

    await expect(linkThenRefreshImportPreview(link, loadImportPreview)).resolves.toEqual({
      stageHashes: { agent: "fresh" },
    });
    expect(order).toEqual(["link", "preview"]);
  });

  it("does not load a preview when linking fails", async () => {
    const loadImportPreview = vi.fn(async () => ({ stageHashes: { agent: "unused" } }));

    await expect(
      linkThenRefreshImportPreview(async () => false, loadImportPreview),
    ).resolves.toBeNull();
    expect(loadImportPreview).not.toHaveBeenCalled();
  });
});
