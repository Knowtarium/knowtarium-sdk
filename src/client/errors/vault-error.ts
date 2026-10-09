/**
 * Why the vault refused data from the server. Callers branch on the code:
 *
 * - `untrusted_signature`: a signature on a wrapped key, key generation or note version doesn't
 *   verify against the trusted key, or signs something else.
 * - `missing_signature`: a note version or delete arrived without the signed event that must
 *   come with it.
 * - `rollback`: older data than this device has already seen (a lower note version or key
 *   generation, or weaker password KDF parameters).
 * - `pin_mismatch`: the account's public keys differ from the ones pinned on this device.
 * - `missing_key`: no verified workspace key is available for the workspace or generation.
 * - `version_mismatch`: the server's version header doesn't match the version asked for, or its
 *   answers contradict each other (it says a note's current version, or a version nothing
 *   replaced, was removed after the history period).
 * - `invalid_note`: a note decrypted fine but isn't a note file this client reads (a newer
 *   format version, or an invalid file name).
 * - `invalid_attachment`: an attachment's metadata or content doesn't hold up (not valid
 *   metadata, or a size other than its metadata says).
 * - `rotation_pending`: the current key generation still holds an agent the owner revoked (this
 *   device remembers the revocation, or a valid signed one is listed), so nothing is written with
 *   it until a rotation leaves the agent out (`rotateWorkspace` or `revokeAndRotate`).
 */
export type VaultErrorCode =
  | "untrusted_signature"
  | "missing_signature"
  | "rollback"
  | "pin_mismatch"
  | "missing_key"
  | "version_mismatch"
  | "invalid_note"
  | "rotation_pending"
  | "invalid_attachment";

/** Data from the server failed a check the client makes itself. Messages never hold content. */
export class VaultError extends Error {
  override readonly name = "VaultError";

  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `error` is a `VaultError`, optionally with the given code. */
export function isVaultError(error: unknown, code?: VaultErrorCode): error is VaultError {
  return error instanceof VaultError && (code === undefined || error.code === code);
}

/**
 * A note too large to store: its encrypted note file is over the protocol's `LIMITS.noteBytes`
 * (6 MiB, room for about 4 MiB of note text). Nothing was sent.
 */
export class NoteTooLargeError extends Error {
  override readonly name = "NoteTooLargeError";

  constructor(
    /** The encrypted size, in bytes. */
    readonly bytes: number,
    /** The limit, in bytes. */
    readonly limit: number,
  ) {
    const mib = (value: number) => (value / (1024 * 1024)).toFixed(1);
    super(
      `This note is too large to store: its encrypted file is ${mib(bytes)} MiB and the limit is ${mib(limit)} MiB (about 4 MiB of note text).`,
    );
  }
}
