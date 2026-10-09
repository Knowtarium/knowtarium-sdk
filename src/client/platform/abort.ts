// Cancellation without DOM types: the slice of `AbortSignal` and `AbortController` the client
// uses. The runtime's `AbortSignal` fits `AbortSignalLike`.

/** A signal a caller passes to cancel a request (the runtime's `AbortSignal`). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

interface AbortGlobals {
  AbortController?: new () => AbortControllerLike;
}

/** A new `AbortController` from the runtime, or undefined where there is none. */
export function createAbortController(): AbortControllerLike | undefined {
  const Controller = (globalThis as unknown as AbortGlobals).AbortController;
  return Controller === undefined ? undefined : new Controller();
}

/** Why an attempt stopped early. */
export type AbortReason = "aborted" | "timeout";

/** Thrown inside the client when an attempt is cut short; mapped to a `NetworkError`. */
export class AttemptAborted extends Error {
  constructor(readonly reason: AbortReason) {
    super(reason);
  }
}

/**
 * Settles with `promise`, or rejects with `AttemptAborted` as soon as `cancelled` does, so a
 * timeout works even with a `fetch` that ignores its signal.
 */
export function raceAbort<T>(promise: Promise<T>, cancelled: Promise<never>): Promise<T> {
  return Promise.race([promise, cancelled]);
}
