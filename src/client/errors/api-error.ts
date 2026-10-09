import type { ApiError, ErrorCode } from "../../protocol/index.js";

/**
 * The sync API answered with an error. `code` is the protocol's stable error code (branch on it,
 * never on `message`), and `detail` is the parsed error body, so a `conflict` carries
 * `currentVersion` and a `rate_limited` carries `retryAfterSeconds`.
 */
export class SyncApiError extends Error {
  override readonly name = "SyncApiError";

  constructor(
    /** The HTTP status of the response. */
    readonly status: number,
    /** The error body, or one made up from the status when the body wasn't a protocol error. */
    readonly detail: ApiError,
    /** The route that failed, as `"PUT /workspaces/:workspaceId/notes/:noteId"`. */
    readonly route: string,
  ) {
    super(`${route}: ${detail.code}`);
  }

  /** The protocol error code. */
  get code(): ErrorCode {
    return this.detail.code;
  }

  /** For a `conflict`: the version that is current on the server. */
  get currentVersion(): number | undefined {
    return this.detail.code === "conflict" ? this.detail.currentVersion : undefined;
  }
}

/** Whether `error` is a `SyncApiError`, optionally with the given code. */
export function isSyncApiError(error: unknown, code?: ErrorCode): error is SyncApiError {
  return error instanceof SyncApiError && (code === undefined || error.code === code);
}
