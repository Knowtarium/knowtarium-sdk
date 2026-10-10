import { isCryptoError } from "../crypto/errors.js";
import {
  concatBytes,
  fromBase64Url,
  readUint32BE,
  uint32BE,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding.js";
import { ClipError } from "./errors.js";
import type { ClipSodium } from "./lib.js";
import {
  CLIP_FORMAT_VERSION,
  CLIP_LIMITS,
  clipCanonicalJson,
  type ClipInput,
  type ClipPayload,
  clipSigningMessage,
  normalizeClip,
} from "./payload.js";

// The bytes of a clip:
//
//   signed plaintext: 0x01 || Ed25519 signature (64) || canonical JSON of the payload, UTF-8
//   padded:           sodium_pad(signed plaintext, 1024)
//   sealed clip:      0x01 || key generation (uint32 BE) || crypto_box_seal(padded, inbox public key)
//
// The signature is inside the seal, so the server can neither forge a clip nor link signatures.
// The server reads only the 5 header bytes; a sealed clip is at most 24 KiB.

/** Bytes of an Ed25519 signature. */
const SIGNATURE_BYTES = 64;
/** Bytes `crypto_box_seal` adds: the ephemeral public key and the tag. */
export const SEAL_OVERHEAD_BYTES = 48;
/** The sealed clip's header: the format byte and the key generation. */
export const SEALED_CLIP_HEADER_BYTES = 5;

/** The inbox public key a clip is sealed to: its key generation and the X25519 public half. */
export interface InboxPublicKey {
  readonly generation: number;
  /** 32 bytes, or base64url as an `inbox_key` envelope carries it. */
  readonly publicKey: Uint8Array | string;
}

/** What a filer reads from an opened clip before checking it. */
export interface ClipPlaintext {
  readonly signature: Uint8Array;
  /** The payload's JSON exactly as signed; the filer checks it is canonical and clean. */
  readonly json: string;
}

/** An Ed25519 secret key in libsodium's 64-byte layout, or a 32-byte public key. */
function key(bytes: Uint8Array | string, length: number, what: string): Uint8Array {
  let value: Uint8Array;
  try {
    value = typeof bytes === "string" ? fromBase64Url(bytes) : bytes;
  } catch {
    throw new ClipError("invalid", `${what} is malformed`);
  }
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new ClipError("invalid", `${what} must be ${String(length)} bytes`);
  }
  return value;
}

function generation(value: number): Uint8Array {
  try {
    if (value < 1) throw new ClipError("invalid", "a key generation is 1 or more");
    return uint32BE(value);
  } catch (error) {
    if (isCryptoError(error)) throw new ClipError("invalid", "a key generation is 1 or more");
    throw error;
  }
}

/** The signed plaintext of a clean payload: version, signature, canonical JSON. */
export function signClip(
  lib: ClipSodium,
  payload: ClipPayload,
  signingSecretKey: Uint8Array,
): Uint8Array {
  const secret = key(signingSecretKey, 64, "the signing key");
  const signature = lib.crypto_sign_detached(clipSigningMessage(payload), secret);
  return concatBytes(
    Uint8Array.of(CLIP_FORMAT_VERSION),
    signature,
    utf8Encode(clipCanonicalJson(payload)),
  );
}

/**
 * Cleans the payload (`normalizeClip`), signs it with the extension's key, pads it and seals it to
 * the inbox key of one generation. Throws `ClipError`: what `normalizeClip` throws, `invalid` for
 * a key of the wrong size, `too_long` when the sealed clip would pass 24 KiB.
 */
export function signAndSealClipWith(
  lib: ClipSodium,
  payload: ClipInput,
  options: { readonly signingSecretKey: Uint8Array; readonly inboxKey: InboxPublicKey },
): Uint8Array {
  const clean = normalizeClip(payload);
  const publicKey = key(options.inboxKey.publicKey, 32, "the inbox public key");
  const header = concatBytes(
    Uint8Array.of(CLIP_FORMAT_VERSION),
    generation(options.inboxKey.generation),
  );
  const plaintext = signClip(lib, clean, options.signingSecretKey);
  const padded = lib.pad(plaintext, CLIP_LIMITS.padBlockBytes);
  lib.memzero(plaintext);
  if (header.length + SEAL_OVERHEAD_BYTES + padded.length > CLIP_LIMITS.sealedBytes) {
    lib.memzero(padded);
    throw new ClipError("too_long", "the clip is over 24 KiB sealed");
  }
  const sealed = lib.crypto_box_seal(padded, publicKey);
  lib.memzero(padded);
  return concatBytes(header, sealed);
}

/** The header of a sealed clip, as the server reads it; throws `invalid` for a malformed one. */
export function readSealedClipHeader(blob: Uint8Array): {
  readonly version: number;
  readonly generation: number;
} {
  if (blob.length < SEALED_CLIP_HEADER_BYTES + SEAL_OVERHEAD_BYTES) {
    throw new ClipError("invalid", "the sealed clip is too short");
  }
  return { version: blob[0] ?? 0, generation: readUint32BE(blob, 1) };
}

/**
 * Splits an unpadded signed plaintext into the signature and the payload's JSON text. Throws
 * `invalid` for another version byte, a short plaintext or bytes that aren't UTF-8.
 */
export function parseClipPlaintext(plaintext: Uint8Array): ClipPlaintext {
  if (plaintext.length <= 1 + SIGNATURE_BYTES || plaintext[0] !== CLIP_FORMAT_VERSION) {
    throw new ClipError("invalid", "not a signed clip of this version");
  }
  let json: string;
  try {
    json = utf8Decode(plaintext.subarray(1 + SIGNATURE_BYTES));
  } catch {
    throw new ClipError("invalid", "the clip isn't UTF-8");
  }
  return { signature: plaintext.slice(1, 1 + SIGNATURE_BYTES), json };
}

/**
 * The payload of a clip's JSON text, when the text is exactly the canonical JSON of a clean
 * payload (what `normalizeClip` would leave unchanged); `invalid` otherwise.
 */
export function readClipJson(json: string): ClipPayload {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ClipError("invalid", "the clip isn't JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClipError("invalid", "a clip is an object");
  }
  const record = value as Record<string, unknown>;
  if (record["v"] !== CLIP_FORMAT_VERSION) throw new ClipError("invalid", "not a version 1 clip");
  const payload = normalizeClip(record as unknown as ClipPayload);
  if (clipCanonicalJson(payload) !== json) {
    throw new ClipError("invalid", "the clip isn't canonical and clean");
  }
  return payload;
}

/** Whether `signature` is the extension's over this payload. */
export function clipSignatureValid(
  lib: Pick<ClipSodium, "crypto_sign_verify_detached">,
  payload: ClipPayload,
  signature: Uint8Array,
  signPublicKey: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_BYTES || signPublicKey.length !== 32) return false;
  try {
    return lib.crypto_sign_verify_detached(signature, clipSigningMessage(payload), signPublicKey);
  } catch {
    return false;
  }
}
