/**
 * A tiny, pure-timing cadence scheduler. It periodically invokes a `tick`
 * callback, guarantees ticks never overlap, and survives tick failures so the
 * loop keeps firing. It intentionally knows nothing about config or core — the
 * caller supplies the work via `tick`.
 */
export interface CadenceScheduler {
  stop(): void;
}

export interface CadenceSchedulerOptions {
  /** Called on each tick to do the work (read config + maybe run analysis). Must resolve. */
  tick: () => Promise<void>;
  /** Poll interval in ms (default 60_000). */
  intervalMs?: number;
  /** Injectable timer seam for tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Swallow + report tick errors so the loop never dies. */
  onError?: (err: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function startCadenceScheduler(opts: CadenceSchedulerOptions): CadenceScheduler {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const onError = opts.onError ?? (() => {});

  let running = false;

  const timer = setIntervalFn(() => {
    // Skip this firing if the previous tick is still in flight — never overlap.
    if (running) return;
    running = true;
    Promise.resolve()
      .then(() => opts.tick())
      .catch((err) => onError(err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  return {
    stop(): void {
      clearIntervalFn(timer);
    },
  };
}
