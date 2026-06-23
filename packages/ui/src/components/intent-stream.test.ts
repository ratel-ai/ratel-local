import { describe, expect, it } from "vitest";
import { reconcileStreamOrder } from "./intent-stream";

describe("reconcileStreamOrder", () => {
  it("adopts the incoming order on a first reconcile (empty prior)", () => {
    const { order, added } = reconcileStreamOrder([], ["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(added).toEqual(["a", "b", "c"]);
  });

  it("keeps survivors in their prior slot and prepends newcomers at the top", () => {
    // Server re-ranks to [c, a, b, d] but a/b/c already shown — they must NOT reshuffle;
    // only the genuinely new "d" is added, and it arrives at the TOP.
    const { order, added } = reconcileStreamOrder(["a", "b", "c"], ["c", "a", "b", "d"]);
    expect(order).toEqual(["d", "a", "b", "c"]);
    expect(added).toEqual(["d"]);
  });

  it("reports nothing added when the set is unchanged", () => {
    const { order, added } = reconcileStreamOrder(["a", "b"], ["b", "a"]);
    expect(order).toEqual(["a", "b"]);
    expect(added).toEqual([]);
  });

  it("drops contents that have gone away", () => {
    const { order, added } = reconcileStreamOrder(["a", "b", "c"], ["a", "c"]);
    expect(order).toEqual(["a", "c"]);
    expect(added).toEqual([]);
  });

  it("re-adds a content that left and came back at the top (treated as new)", () => {
    const afterLeaving = reconcileStreamOrder(["a", "b"], ["a"]);
    expect(afterLeaving.order).toEqual(["a"]);
    const afterReturn = reconcileStreamOrder(afterLeaving.order, ["a", "b"]);
    expect(afterReturn.order).toEqual(["b", "a"]);
    expect(afterReturn.added).toEqual(["b"]);
  });

  it("prepends multiple newcomers ahead of survivors, in incoming order", () => {
    const { order, added } = reconcileStreamOrder(["a"], ["a", "x", "y", "z"]);
    expect(order).toEqual(["x", "y", "z", "a"]);
    expect(added).toEqual(["x", "y", "z"]);
  });
});
