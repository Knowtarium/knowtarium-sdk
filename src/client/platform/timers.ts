/** An opaque timer handle. */
export type TimerHandle = unknown;

/**
 * Timers, injectable so tests control time. Every runtime the SDK supports has `setTimeout`, but
 * `src/` is typed without DOM or Node globals, so the default reaches it through `globalThis`.
 */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Milliseconds since the epoch. */
  now(): number;
}

interface TimerGlobals {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The runtime's own timers and clock. */
export const systemScheduler: Scheduler = {
  setTimeout: (callback, ms) => (globalThis as unknown as TimerGlobals).setTimeout(callback, ms),
  clearTimeout: (handle) => {
    (globalThis as unknown as TimerGlobals).clearTimeout(handle);
  },
  now: () => Date.now(),
};

/** Resolves after `ms` milliseconds on `scheduler`. */
export function sleep(scheduler: Scheduler, ms: number): Promise<void> {
  return new Promise((resolve) => {
    scheduler.setTimeout(resolve, ms);
  });
}
