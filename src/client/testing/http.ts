// Test helpers: responses and a scheduler the tests control. Not exported by the package.
import { utf8Encode } from "../../crypto/encoding.js";
import type { FetchInit, FetchResponse } from "../platform/fetch.js";
import type { Scheduler, TimerHandle } from "../platform/timers.js";

/** A response as `fetch` would return it. */
export function response(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): FetchResponse {
  const bytes =
    body instanceof Uint8Array
      ? body
      : body === undefined
        ? new Uint8Array()
        : utf8Encode(JSON.stringify(body));
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  };
}

/** A recorded `fetch` call. */
export interface RecordedCall {
  readonly url: string;
  readonly init: FetchInit;
}

/** A header of a recorded call, case-insensitively. */
export function header(call: RecordedCall | undefined, name: string): string | undefined {
  const entry = Object.entries(call?.init.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

/** A scheduler whose time moves only when the test says so. */
export class ManualScheduler implements Scheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  /** Every delay asked for, in order. */
  readonly delays: number[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.delays.push(ms);
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** How many timers are waiting. */
  get pending(): number {
    return this.timers.size;
  }

  /** Moves time forward, running every timer that comes due (and the promises they settle). */
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      await flush();
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = until;
    await flush();
  }
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
