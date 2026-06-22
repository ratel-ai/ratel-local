import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCadenceScheduler } from "./scheduler.js";

describe("startCadenceScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fires the tick once per interval", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const scheduler = startCadenceScheduler({ tick, intervalMs: 1_000 });

    expect(tick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("defaults to a 60s interval", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const scheduler = startCadenceScheduler({ tick });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(tick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("skips a firing while the previous tick is still in flight (no overlap)", async () => {
    let resolveTick: (() => void) | undefined;
    const tick = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const scheduler = startCadenceScheduler({ tick, intervalMs: 1_000 });

    // First firing starts a tick that never resolves yet.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    // Two more firings happen while the first tick is still pending -> skipped.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(1);

    // Let the in-flight tick finish.
    resolveTick?.();
    await vi.advanceTimersByTimeAsync(0);

    // Next firing runs a fresh tick.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("catches a throwing tick (onError called) and keeps the schedule alive", async () => {
    const error = new Error("boom");
    const tick = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const scheduler = startCadenceScheduler({ tick, intervalMs: 1_000, onError });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);

    // Schedule continues despite the error.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("swallows tick errors when no onError is provided", async () => {
    const tick = vi.fn().mockRejectedValue(new Error("boom"));
    const scheduler = startCadenceScheduler({ tick, intervalMs: 1_000 });

    // No onError handler: errors must be swallowed. If they propagated, this
    // await would reject and fail the test.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("stop() halts further ticks", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const scheduler = startCadenceScheduler({ tick, intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    scheduler.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("uses injectable timer seams", () => {
    const clearIntervalFn = vi.fn();
    const handle = { id: "timer" } as unknown as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn().mockReturnValue(handle) as unknown as typeof setInterval;

    const scheduler = startCadenceScheduler({
      tick: vi.fn().mockResolvedValue(undefined),
      intervalMs: 2_000,
      setIntervalFn,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect((setIntervalFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(2_000);

    scheduler.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });
});
