/**
 * The request never got an answer. `reason` says why: `network` (the network failed, the runtime
 * refused it, or the server redirected: the client asks `fetch` to treat any redirect as an error,
 * so credentials and ciphertext never follow one), `timeout` (no complete answer in time), or
 * `aborted` (the caller's signal fired).
 */
export class NetworkError extends Error {
  override readonly name = "NetworkError";

  constructor(
    readonly route: string,
    readonly reason: "network" | "timeout" | "aborted" = "network",
    options?: { cause?: unknown },
  ) {
    super(`${route}: the request failed before a response arrived (${reason})`, options);
  }
}

/** The server answered, but not with what the route's schema promises. */
export class InvalidResponseError extends Error {
  override readonly name = "InvalidResponseError";

  constructor(
    readonly route: string,
    /** What was wrong, without any response content. */
    readonly problem: string,
  ) {
    super(`${route}: invalid response (${problem})`);
  }
}

/**
 * The client refused to send a request: its path parameters, query, headers or body failed the
 * route's schema, or the route needs another way to authenticate than this client has.
 */
export class RequestValidationError extends Error {
  override readonly name = "RequestValidationError";

  constructor(
    readonly route: string,
    /** Which part failed: `params`, `query`, `headers`, `body` or `auth`. */
    readonly part: "params" | "query" | "headers" | "body" | "auth",
    /** Where in that part, as schema keys (never values). */
    readonly at: readonly (string | number)[] = [],
  ) {
    super(`${route}: invalid ${part}${at.length > 0 ? ` at ${at.join(".")}` : ""}`);
  }
}

/**
 * The sync engine stopped for good: the server revoked the agent token or the session lost
 * access. Make a new engine after signing in or connecting again; see `SyncEngine` for clearing
 * the cache.
 */
export class SyncStoppedError extends Error {
  override readonly name = "SyncStoppedError";

  constructor() {
    super("the sync engine stopped: access was revoked");
  }
}
