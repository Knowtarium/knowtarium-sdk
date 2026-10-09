/**
 * Runs tasks one at a time, in the order they were queued. The engine sends every pull and every
 * write through one queue, so a pull never applies a feed page read before this client's own
 * write finished (which would look like a rollback).
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Queues `task`; resolves or rejects with it. A failed task doesn't stop the ones after it. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
