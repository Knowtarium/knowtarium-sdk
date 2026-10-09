import { RETRY_AFTER_HEADER } from "../../protocol/index.js";
import type { FetchResponse } from "../platform/fetch.js";

/** When and how long the client waits before sending a request again. */
export interface RetryPolicy {
  /** Attempts in total, the first one included. 1 turns retries off. */
  readonly maxAttempts: number;
  /** The first backoff delay; each retry doubles it, with jitter. */
  readonly baseDelayMs: number;
  /** The longest backoff delay. */
  readonly maxDelayMs: number;
  /** The longest `Retry-After` the client waits for; a longer one fails at once. */
  readonly maxRetryAfterMs: number;
}

/** Four attempts, 300 ms doubling to at most 10 s, and `Retry-After` of up to a minute. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 300,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 60_000,
};

/** Exponential backoff with jitter (half to all of the doubled delay). `attempt` starts at 1. */
export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number): number {
  const full = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(full * (0.5 + random() * 0.5));
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(response: FetchResponse, now: number): number | null {
  const value = response.headers.get(RETRY_AFTER_HEADER)?.trim();
  if (value === undefined || value === "") return null;
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * How long to wait before retrying after a response, or null not to retry. 429 and 503 with a
 * `Retry-After` are retried for every method (the server did not act on the request); other 5xx
 * answers only when the request is idempotent.
 */
export function retryDelayForResponse(
  response: FetchResponse,
  context: {
    readonly policy: RetryPolicy;
    readonly attempt: number;
    readonly idempotent: boolean;
    readonly now: number;
    readonly random: () => number;
  },
): number | null {
  const { policy, attempt, idempotent } = context;
  if (attempt >= policy.maxAttempts) return null;
  const { status } = response;
  if (status === 429 || status === 503) {
    const wait = retryAfterMs(response, context.now);
    if (wait !== null) return wait <= policy.maxRetryAfterMs ? wait : null;
    return idempotent || status === 429 ? backoffDelay(policy, attempt, context.random) : null;
  }
  if (idempotent && (status === 500 || status === 502 || status === 504)) {
    return backoffDelay(policy, attempt, context.random);
  }
  return null;
}
