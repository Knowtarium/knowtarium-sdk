/**
 * Header and cookie names. HTTP header names are case-insensitive: send them as written here, and
 * read them through `headerKey` (the lowercase form every runtime's `Headers` and Hono use).
 */

/** Sent on every request: `Knowtarium-Protocol-Version: 1`. */
export const PROTOCOL_HEADER = "Knowtarium-Protocol-Version";

/**
 * Required on every request that isn't a GET, including unauthenticated ones and Better Auth's
 * endpoints: `Knowtarium-Request: 1`. A cross-site form can't set it, and setting it from script
 * forces a CORS preflight, which only the web app's origin passes. The server refuses a
 * state-changing request without it (`forbidden`).
 */
export const CSRF_HEADER = "Knowtarium-Request";
export const CSRF_HEADER_VALUE = "1";

/** Whether a request with this method must carry `Knowtarium-Request: 1`. */
export function needsCsrfHeader(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

/**
 * On note uploads and deletes: the base version as an entity tag (`If-Match: "3"`, see
 * `formatVersionTag`). `"0"` creates the note. A stale base answers 409 `conflict`.
 */
export const IF_MATCH_HEADER = "If-Match";

/** On note downloads and writes: the note version as an entity tag (`ETag: "4"`). */
export const ETAG_HEADER = "ETag";

/** On 429 and 503 responses: seconds to wait before retrying. */
export const RETRY_AFTER_HEADER = "Retry-After";

/** On note uploads: the folder the note sits in (plaintext, so the server can check scopes). */
export const FOLDER_ID_HEADER = "Knowtarium-Folder-Id";

/**
 * On an agent's pending change upload: a random 16-byte nonce (base64url) the agent made and bound
 * into the proposal's encryption context. The server stores it with the pending change and
 * returns it as `clientNonce`, so the reviewer can decrypt, and a proposal can't be replayed as
 * another pending change without the reviewer seeing the same nonce twice.
 */
export const PENDING_NONCE_HEADER = "Knowtarium-Pending-Nonce";

/**
 * On a person's raw writes (note write, delete, approval) and an agent's direct write
 * (`writeNoteAsAgent`, signed with the agent's own key): the Ed25519 signature, base64url.
 */
export const SIGNATURE_HEADER = "Knowtarium-Signature";

/** On the same raw writes: the signed envelope's `createdAt`, in milliseconds. */
export const SIGNED_AT_HEADER = "Knowtarium-Signed-At";

/**
 * On an agent's direct write (`writeNoteAsAgent`): the agent policy revision the agent checked
 * before writing (`AgentPolicy.revision`, `"0"` when the workspace has no policy yet). It is
 * signed into the `agent_edited` envelope as `revision`, and the server refuses it with
 * `stale_agent_policy` unless it is the current revision.
 */
export const AGENT_POLICY_REVISION_HEADER = "Knowtarium-Agent-Policy-Revision";

/**
 * On a person's note write that applies an agent's passing check: the check record's ID. The
 * server then rebuilds the signature as `check_applied` (with that ID) instead of `edited`, and
 * marks the record applied with the new version.
 */
export const CHECK_ID_HEADER = "Knowtarium-Check-Id";

/** Agents authenticate with `Authorization: Bearer <agent token>`. */
export const AUTHORIZATION_HEADER = "Authorization";

/**
 * The browser session: Better Auth's session cookie, set by the sync API under this name
 * (`advanced.cookies.session_token.name`) with httpOnly, Secure, SameSite=Strict, Path=/ and no
 * Domain. The `__Host-` prefix fits: the cookie belongs to the API host only, and the web app
 * (app. and api. are same-site) sends it with `credentials: "include"`. Better Auth's other
 * cookies (`session_data` when the cookie cache is on, `dont_remember`) get the same prefix and
 * attributes. On http://localhost in development, browsers accept Secure and `__Host-` cookies.
 */
export const SESSION_COOKIE = "__Host-kt_session";

/** Request headers the sync API reads, for its CORS `Access-Control-Allow-Headers`. */
export const REQUEST_HEADERS = [
  PROTOCOL_HEADER,
  CSRF_HEADER,
  IF_MATCH_HEADER,
  FOLDER_ID_HEADER,
  PENDING_NONCE_HEADER,
  SIGNATURE_HEADER,
  SIGNED_AT_HEADER,
  CHECK_ID_HEADER,
  AGENT_POLICY_REVISION_HEADER,
  AUTHORIZATION_HEADER,
  "Content-Type",
] as const;

/** Response headers clients read, for its CORS `Access-Control-Expose-Headers`. */
export const RESPONSE_HEADERS = [ETAG_HEADER, RETRY_AFTER_HEADER] as const;

/** The lowercase form of a header name, as used for the keys of header schemas. */
export function headerKey<const N extends string>(name: N): Lowercase<N> {
  return name.toLowerCase() as Lowercase<N>;
}

/** A note version as an entity tag: `"3"`. */
export function formatVersionTag(version: number): string {
  return `"${String(version)}"`;
}

/** Reads a version entity tag (`"3"`); null when it isn't one. */
export function parseVersionTag(value: string | null | undefined): number | null {
  const match = /^"(0|[1-9][0-9]{0,14})"$/.exec(value?.trim() ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}
