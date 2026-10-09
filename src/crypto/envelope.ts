import { aeadDecrypt, aeadEncrypt, NONCE_BYTES, TAG_BYTES } from "./aead.js";
import { type BlobContext, encodeBlobContext } from "./blob-context.js";
import { concatBytes, readUint32BE, uint32BE, utf8Decode, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { assertWorkspaceKey, type WorkspaceKey, type WorkspaceKeyring } from "./workspace-keys.js";

// The blob envelope: every note version, pending change, event, comment, check record, attachment
// and name is stored as
//
//   formatVersion (1 byte, 0x01) || keyGeneration (uint32 BE) || nonce (24 bytes) || ciphertext
//
// where the ciphertext is XChaCha20-Poly1305 (IETF) under the workspace key of that generation,
// with associated data = the 5 header bytes || the encoded blob context (blob-context.ts). The
// context says what the blob is (kind, workspace, id), so the server can't swap one blob for
// another; the same context must be given to decrypt.

/** The envelope format this SDK writes. */
export const ENVELOPE_FORMAT_VERSION = 1;

/** Bytes before the nonce: format version and key generation. */
export const ENVELOPE_HEADER_BYTES = 5;

/** The smallest valid envelope: header, nonce and the tag of an empty plaintext. */
export const ENVELOPE_MIN_BYTES = ENVELOPE_HEADER_BYTES + NONCE_BYTES + TAG_BYTES;

/** The readable part of an envelope's header. */
export interface EnvelopeHeader {
  readonly formatVersion: number;
  readonly keyGeneration: number;
}

/** Which workspace key(s) to decrypt with: one generation, or a keyring holding several. */
export type WorkspaceKeys = WorkspaceKey | WorkspaceKeyring;

/**
 * Encrypts bytes with a workspace key into an envelope, with a fresh random nonce. `context` says
 * what the blob is; it is bound as associated data and must be passed again to decrypt.
 */
export function encryptBytes(
  key: WorkspaceKey,
  plaintext: Uint8Array,
  context: BlobContext,
): Uint8Array {
  return encryptBytesWithNonce(key, plaintext, context, undefined);
}

/** `encryptBytes` with a chosen nonce, for the test vectors only (not exported by the package). */
export function encryptBytesWithNonce(
  key: WorkspaceKey,
  plaintext: Uint8Array,
  context: BlobContext,
  nonce: Uint8Array | undefined,
): Uint8Array {
  assertWorkspaceKey(key);
  const header = concatBytes(Uint8Array.of(ENVELOPE_FORMAT_VERSION), uint32BE(key.generation));
  const sealed = aeadEncrypt(key.key, plaintext, associatedData(header, context), nonce);
  return concatBytes(header, sealed.nonce, sealed.ciphertext);
}

/**
 * Decrypts an envelope. With a single key, throws `key_generation_mismatch` if the blob uses
 * another generation; with a keyring, `unknown_key_generation` if the keyring lacks it. Throws
 * `decryption_failed` for a wrong key or context or any changed byte.
 */
export function decryptBytes(
  keys: WorkspaceKeys,
  blob: Uint8Array,
  context: BlobContext,
): Uint8Array {
  const { keyGeneration } = readEnvelopeHeader(blob);
  const key = keyFor(keys, keyGeneration);
  const header = blob.subarray(0, ENVELOPE_HEADER_BYTES);
  return aeadDecrypt(
    key.key,
    blob.subarray(ENVELOPE_HEADER_BYTES + NONCE_BYTES),
    associatedData(header, context),
    blob.subarray(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + NONCE_BYTES),
  );
}

/** Encrypts a string as UTF-8. See `encryptBytes`. */
export function encryptText(key: WorkspaceKey, text: string, context: BlobContext): Uint8Array {
  return encryptBytes(key, utf8Encode(text), context);
}

/** Decrypts an envelope holding UTF-8 text. See `decryptBytes`. */
export function decryptText(keys: WorkspaceKeys, blob: Uint8Array, context: BlobContext): string {
  return utf8Decode(decryptBytes(keys, blob, context));
}

/** Encrypts a value as JSON text (`JSON.stringify`). See `encryptBytes`. */
export function encryptJson(key: WorkspaceKey, value: unknown, context: BlobContext): Uint8Array {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new CryptoError("invalid_input", "the value is not JSON");
  return encryptText(key, text, context);
}

/** Decrypts an envelope holding JSON and parses it. Validate the result before trusting its shape. */
export function decryptJson(keys: WorkspaceKeys, blob: Uint8Array, context: BlobContext): unknown {
  const text = decryptText(keys, blob, context);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CryptoError("invalid_input", "the decrypted text is not JSON");
  }
}

/**
 * Reads an envelope's header without decrypting, for example to find blobs still written with an
 * old key generation. Throws `malformed_envelope` or `unsupported_version`.
 */
export function readEnvelopeHeader(blob: Uint8Array): EnvelopeHeader {
  if (!(blob instanceof Uint8Array) || blob.length < ENVELOPE_MIN_BYTES) {
    throw new CryptoError("malformed_envelope", "the blob is too short to be an envelope");
  }
  const formatVersion = blob[0] ?? 0;
  if (formatVersion !== ENVELOPE_FORMAT_VERSION) {
    throw new CryptoError("unsupported_version", "unsupported envelope format version");
  }
  return { formatVersion, keyGeneration: readUint32BE(blob, 1) };
}

function keyFor(keys: WorkspaceKeys, generation: number): WorkspaceKey {
  if ("get" in keys) {
    const key = keys.get(generation);
    if (key === undefined) {
      throw new CryptoError("unknown_key_generation", "no workspace key for this generation");
    }
    return key;
  }
  if (keys.generation !== generation) {
    throw new CryptoError(
      "key_generation_mismatch",
      "the blob was written with another key generation",
    );
  }
  return keys;
}

function associatedData(header: Uint8Array, context: BlobContext): Uint8Array {
  return concatBytes(header, encodeBlobContext(context));
}
