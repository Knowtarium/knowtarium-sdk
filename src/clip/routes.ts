import type { SignedInboxKey } from "./keys.js";

// The part of the sync API the extension calls, as plain values: knowtarium/clip carries no zod
// and no route table. Every route and type here is the same as knowtarium/protocol's
// (`startConnect`, `pollConnect`, `postClip`, `getExtensionInboxKey`, `revokeCurrentExtension`),
// which a test checks. Every request sends `Knowtarium-Protocol-Version: 2`, and every request
// that isn't a GET also `Knowtarium-Request: 1`; the extension routes take the token as
// `Authorization: Bearer kte_...`.

/** The protocol version the extension speaks, and the headers every request carries. */
export const EXTENSION_PROTOCOL = {
  version: 2,
  versionHeader: "Knowtarium-Protocol-Version",
  /** Sent with value `1` on every request that isn't a GET. */
  requestHeader: "Knowtarium-Request",
} as const;

/** The routes the extension calls, by the protocol's names. */
export const EXTENSION_ROUTES = {
  /** Body `StartExtensionConnectRequest`, 201 `StartConnectResponse`. No auth. */
  startConnect: { method: "POST", path: "/connect-requests" },
  /** Body `PollConnectRequest`, 200 `PollConnectResponse`. No auth. */
  pollConnect: { method: "POST", path: "/connect-requests/:requestId/poll" },
  /** Body `PostClipRequest`, 201 or 200 `PostClipResponse`. The extension's token. */
  postClip: { method: "POST", path: "/extensions/current/clips" },
  /** 200 `ExtensionInboxKeyResponse`. The extension's token. */
  getExtensionInboxKey: { method: "GET", path: "/extensions/current/inbox-key" },
  /** 200 `{ ok: true }`: the token stops working. The extension's token. */
  revokeCurrentExtension: { method: "DELETE", path: "/extensions/current" },
} as const;

/** The web app page the extension opens: `<app>/connect/extension?request=<id>#<fragment>`. */
export const EXTENSION_CONNECT_PAGE_PATH = "/connect/extension";

export interface StartExtensionConnectRequest {
  readonly client: "extension";
  /** The extension's version (semver). */
  readonly extensionVersion: string;
}

export interface StartConnectResponse {
  readonly requestId: string;
  readonly pollSecret: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
}

export interface PollConnectRequest {
  readonly pollSecret: string;
}

/** `relayed` carries the sealed pairing payload (base64url), once. */
export type PollConnectResponse =
  | { readonly status: "pending"; readonly pollIntervalSeconds: number }
  | { readonly status: "approved"; readonly pollIntervalSeconds: number }
  | { readonly status: "relayed"; readonly encRelayPayload: string }
  | { readonly status: "denied" }
  | { readonly status: "expired" }
  | { readonly status: "completed" };

export interface PostClipRequest {
  readonly clipId: string;
  /** The sealed clip, base64url. */
  readonly blob: string;
}

export interface PostClipResponse {
  readonly status: "queued" | "duplicate";
}

export interface ExtensionInboxKeyResponse {
  readonly inboxKey: SignedInboxKey;
}

/** The error codes the extension's routes answer, with their HTTP status. */
export const EXTENSION_ERROR_STATUS = {
  invalid_request: 400,
  unsupported_protocol: 400,
  unauthenticated: 401,
  token_revoked: 401,
  quota_exceeded: 402,
  forbidden: 403,
  not_found: 404,
  already_exists: 409,
  /** The body carries the latest `inboxKey`: verify it, seal again, retry once. */
  stale_inbox_key: 409,
  expired: 410,
  payload_too_large: 413,
  rate_limited: 429,
  inbox_full: 429,
  internal: 500,
  unavailable: 503,
} as const;

export type ExtensionErrorCode = keyof typeof EXTENSION_ERROR_STATUS;

/** An error body: `{ "error": { "code": ..., "message": ... } }`, plus the code's own fields. */
export interface ExtensionErrorBody {
  readonly error: {
    readonly code: ExtensionErrorCode;
    readonly message: string;
    /** With `stale_inbox_key`. */
    readonly inboxKey?: SignedInboxKey;
    /** With `rate_limited` (also the `Retry-After` header). */
    readonly retryAfterSeconds?: number;
  };
}
