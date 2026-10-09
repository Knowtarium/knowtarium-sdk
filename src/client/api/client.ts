import type { RouteBase } from "../../protocol/index.js";
import { routeKey } from "../../protocol/index.js";
import { NetworkError } from "../errors/index.js";
import {
  type AbortReason,
  type AbortSignalLike,
  AttemptAborted,
  createAbortController,
  raceAbort,
} from "../platform/abort.js";
import type { FetchLike, FetchResponse } from "../platform/fetch.js";
import { type Scheduler, sleep, systemScheduler } from "../platform/timers.js";
import { type BuiltRequest, buildRequest, type LooseInput } from "./request.js";
import { readFailure, readSuccess } from "./response.js";
import {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  retryDelayForResponse,
  type RetryPolicy,
} from "./retry.js";
import type { ApiResult, AuthMode, CallArgs, CallOptions } from "./types.js";

/** How to reach the sync API. */
export interface ApiClientOptions {
  /** The sync API's origin and base path, for example `https://api.knowtarium.com`. */
  readonly baseUrl: string;
  /** The runtime's `fetch`, a wrapper around it, or a test double. */
  readonly fetch: FetchLike;
  readonly auth: AuthMode;
  /** Extra headers on every request (for example a CLI user agent); the fixed ones win. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly retry?: Partial<RetryPolicy>;
  /** Milliseconds each attempt may take by default (30 s); 0 means no limit. */
  readonly timeoutMs?: number;
  readonly scheduler?: Scheduler;
  /** A number in [0, 1) for backoff jitter; defaults to `Math.random`. */
  readonly random?: () => number;
}

/** A typed client for every route in the protocol's route table. */
export interface ApiClient {
  /** The base URL requests go to, without a trailing slash. */
  readonly baseUrl: string;
  readonly auth: AuthMode;
  /**
   * Calls a route: `client.call(routes.getWorkspace, { params: { workspaceId } })`. Validates the
   * request before sending and the response before returning; throws `SyncApiError` for protocol
   * errors, `NetworkError` (network, timeout or abort), `InvalidResponseError` or
   * `RequestValidationError`.
   */
  call<R extends RouteBase>(route: R, ...args: CallArgs<R>): Promise<ApiResult<R>>;
}

/** The default time an attempt may take. */
export const DEFAULT_TIMEOUT_MS = 30_000;

type SendInput = LooseInput & CallOptions;

interface Answer {
  readonly response: FetchResponse;
  readonly bytes: Uint8Array;
}

/** Creates an API client. It keeps no state besides its options, so share one per auth mode. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const scheduler = options.scheduler ?? systemScheduler;
  const random = options.random ?? Math.random;
  const extraHeaders = options.headers ?? {};

  /** One attempt, response body included, cut short by the timeout or the caller's signal. */
  async function attempt(
    request: BuiltRequest,
    signal: AbortSignalLike | undefined,
    timeoutMs: number,
  ): Promise<Answer> {
    if (signal?.aborted === true) throw new AttemptAborted("aborted");
    const controller = createAbortController();
    let cancel: (reason: AbortReason) => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = (reason) => {
        reject(new AttemptAborted(reason));
        controller?.abort();
      };
    });
    cancelled.catch(() => undefined);
    const onAbort = () => {
      cancel("aborted");
    };
    signal?.addEventListener("abort", onAbort);
    const timer =
      timeoutMs > 0
        ? scheduler.setTimeout(() => {
            cancel("timeout");
          }, timeoutMs)
        : undefined;
    try {
      const response = await raceAbort(
        options.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          cache: "no-store",
          redirect: "error",
          credentials: options.auth.kind === "session" ? "include" : "omit",
          ...(controller === undefined ? {} : { signal: controller.signal }),
        }),
        cancelled,
      );
      const bytes = new Uint8Array(await raceAbort(response.arrayBuffer(), cancelled));
      return { response, bytes };
    } finally {
      if (timer !== undefined) scheduler.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Waits before a retry; fails at once if the caller aborts meanwhile. */
  async function wait(route: RouteBase, ms: number, signal: AbortSignalLike | undefined) {
    await sleep(scheduler, ms);
    if (signal?.aborted === true) throw new NetworkError(routeKey(route), "aborted");
  }

  async function send(route: RouteBase, input: SendInput) {
    const request = buildRequest(route, input, { baseUrl, auth: options.auth, extraHeaders });
    const idempotent = input.idempotent ?? route.method === "GET";
    const timeoutMs = input.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let attemptNumber = 1; ; attemptNumber++) {
      let answer: Answer;
      try {
        answer = await attempt(request, input.signal, timeoutMs);
      } catch (error) {
        const reason = error instanceof AttemptAborted ? error.reason : "network";
        if (reason === "aborted" || !idempotent || attemptNumber >= policy.maxAttempts) {
          throw new NetworkError(routeKey(route), reason, { cause: error });
        }
        await wait(route, backoffDelay(policy, attemptNumber, random), input.signal);
        continue;
      }
      const { response, bytes } = answer;
      if (response.status >= 200 && response.status < 300) {
        return readSuccess(route, response, bytes);
      }
      const delay = retryDelayForResponse(response, {
        policy,
        attempt: attemptNumber,
        idempotent,
        now: scheduler.now(),
        random,
      });
      if (delay === null) throw readFailure(route, response, bytes);
      await wait(route, delay, input.signal);
    }
  }

  return {
    baseUrl,
    auth: options.auth,
    call: (route, ...args) => send(route, args[0] ?? {}) as Promise<ApiResult<typeof route>>,
  };
}
