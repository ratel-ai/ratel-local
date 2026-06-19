import { describe, expect, it } from "vitest";
import { estimateToolCountTokens, estimateToolPayloadTokens } from "./usage.js";

describe("usage estimator", () => {
  it("estimates payload tokens deterministically independent of object key order", () => {
    const a = estimateToolPayloadTokens([
      { name: "read", description: "Read files", inputSchema: { type: "object", a: 1, b: 2 } },
    ]);
    const b = estimateToolPayloadTokens([
      { inputSchema: { b: 2, a: 1, type: "object" }, description: "Read files", name: "read" },
    ]);

    expect(a).toEqual(b);
    expect(a.strategy).toBe("payload");
    expect(a.estimatedTokens).toBeGreaterThan(0);
  });

  it("supports a deterministic tool-count fallback", () => {
    expect(estimateToolCountTokens(3)).toEqual({
      toolCount: 3,
      estimatedTokens: 390,
      strategy: "count-fallback",
    });
    expect(estimateToolCountTokens(-1).estimatedTokens).toBe(0);
  });
});
