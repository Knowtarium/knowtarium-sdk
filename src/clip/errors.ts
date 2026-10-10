/**
 * Why a clip or a pairing failed. Callers branch on the code, never on the message.
 *
 * - `not_ready`: a function ran before `await ready()`.
 * - `invalid`: a field can't be made valid (an ID of the wrong kind, a malformed time, an unknown
 *   field, a key of the wrong size).
 * - `too_long`: a field is over its limit (`CLIP_LIMITS`), or the sealed clip would be.
 * - `bad_url`: the link isn't an `http:` or `https:` URL.
 * - `bad_payload`: a pairing payload the one-time secret doesn't open, or of the wrong shape.
 * - `wrong_key`: the pairing's `extension_key` doesn't vouch for this extension's own key.
 * - `bad_signature`: the pairing's `inbox_key` doesn't verify for its account and workspace.
 */
export type ClipErrorCode =
  "not_ready" | "invalid" | "too_long" | "bad_url" | "bad_payload" | "wrong_key" | "bad_signature";

/** The one error type `knowtarium/clip` throws. Messages never contain the clip's text or keys. */
export class ClipError extends Error {
  override readonly name = "ClipError";

  constructor(
    readonly code: ClipErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `error` is a `ClipError`, optionally with the given code. */
export function isClipError(error: unknown, code?: ClipErrorCode): error is ClipError {
  return error instanceof ClipError && (code === undefined || error.code === code);
}
