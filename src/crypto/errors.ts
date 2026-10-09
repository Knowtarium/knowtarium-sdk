/**
 * Why a crypto operation failed. Callers branch on the code, never on the message.
 *
 * - `not_ready`: a function ran before `await ready()`.
 * - `invalid_input`: a key, nonce or argument has the wrong type or size.
 * - `invalid_kdf_params`: password KDF parameters are outside the accepted range (too weak or too costly).
 * - `malformed_envelope`: a blob or wrapped key is too short or structurally wrong.
 * - `unsupported_version`: a blob or wrapped key uses a format version this SDK does not know.
 * - `key_generation_mismatch`: the blob was written with another workspace key generation than the key given.
 * - `unknown_key_generation`: the keyring holds no key for the blob's generation.
 * - `decryption_failed`: authentication failed (wrong key, wrong context, or tampered bytes).
 * - `invalid_signature`: a signature that must be valid (for example on a wrapped key) is not.
 * - `key_mismatch`: unwrapped keys don't match the public keys they were expected to match.
 * - `invalid_recovery_code`: a recovery code has bad characters, the wrong length or a bad checksum.
 * - `non_canonical_json`: a value can't be encoded as canonical JSON (see `canonicalJson`).
 */
export type CryptoErrorCode =
  | "not_ready"
  | "invalid_input"
  | "invalid_kdf_params"
  | "malformed_envelope"
  | "unsupported_version"
  | "key_generation_mismatch"
  | "unknown_key_generation"
  | "decryption_failed"
  | "invalid_signature"
  | "key_mismatch"
  | "invalid_recovery_code"
  | "non_canonical_json";

/**
 * The one error type `knowtarium/crypto` throws. Messages are fixed strings chosen by the SDK: they
 * never contain key material, plaintext, passwords or recovery codes.
 */
export class CryptoError extends Error {
  override readonly name = "CryptoError";

  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `error` is a `CryptoError`, optionally with the given code. */
export function isCryptoError(error: unknown, code?: CryptoErrorCode): error is CryptoError {
  return error instanceof CryptoError && (code === undefined || error.code === code);
}
