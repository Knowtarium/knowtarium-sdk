import { z } from "zod";

import { Base64Url, base64UrlLength } from "./primitives.js";

/**
 * The smallest encrypted envelope from `knowtarium/crypto`: format version (1 byte), key generation
 * (4 bytes), nonce (24 bytes) and the Poly1305 tag (16 bytes) around an empty plaintext.
 */
export const ENVELOPE_OVERHEAD_BYTES = 45;

/** Size limits the sync API enforces, in bytes of ciphertext. */
export const LIMITS = {
  /** An encrypted workspace, folder or token name. */
  encNameBytes: 1024,
  /** An attachment's encrypted metadata (file name, media type, size). */
  encAttachmentMetaBytes: 2048,
  /** An encrypted event, comment or check record. */
  recordBytes: 64 * 1024,
  /**
   * One note version or pending change (a raw body): 6 MiB. The intent is notes of up to about
   * 4 MiB of raw OKF text; the blob holds that text wrapped in the note file's JSON (escaping
   * newlines, quotes and backslashes takes two bytes each, controls six) plus the envelope, so the
   * limit leaves room above 4 MiB.
   */
  noteBytes: 6 * 1024 * 1024,
  /** One attachment chunk (a raw body). */
  attachmentChunkBytes: 8 * 1024 * 1024,
  /** A whole attachment. */
  attachmentBytes: 512 * 1024 * 1024,
} as const;

/**
 * Whether an attachment of `sizeBytes` (all its chunks' ciphertext) may come in `chunkCount`
 * chunks, the rule the sync API enforces on `createAttachment`: enough chunks that none exceeds
 * `LIMITS.attachmentChunkBytes`, and no more than there could be if each held at least one byte
 * past `ENVELOPE_OVERHEAD_BYTES`, except that one chunk is always allowed (an empty file is one
 * empty envelope). Clients choose their chunk size within that.
 */
export function attachmentChunkCountFits(sizeBytes: number, chunkCount: number): boolean {
  return (
    Number.isInteger(sizeBytes) &&
    Number.isInteger(chunkCount) &&
    chunkCount >= Math.ceil(sizeBytes / LIMITS.attachmentChunkBytes) &&
    chunkCount <= Math.max(1, Math.floor(sizeBytes / (ENVELOPE_OVERHEAD_BYTES + 1)))
  );
}

/**
 * User content in a JSON body: an encrypted envelope (events, comments, check records) as
 * base64url. Every field holding one is named `ciphertext`.
 */
export const Ciphertext = Base64Url.min(base64UrlLength(ENVELOPE_OVERHEAD_BYTES)).max(
  base64UrlLength(LIMITS.recordBytes),
);
export type Ciphertext = z.infer<typeof Ciphertext>;

/** An encrypted name (workspace, folder, agent token). Every field holding one is named `enc*`. */
export const EncName = Base64Url.min(base64UrlLength(ENVELOPE_OVERHEAD_BYTES)).max(
  base64UrlLength(LIMITS.encNameBytes),
);
export type EncName = z.infer<typeof EncName>;

/**
 * An attachment's metadata as an envelope (blob kind `attachment_meta`, id = the attachment id):
 * the JSON `{ name, type, sizeBytes }`, with the file name within its folder, the media type and
 * the plaintext size. The server can't read any of it.
 */
export const EncAttachmentMeta = Base64Url.min(base64UrlLength(ENVELOPE_OVERHEAD_BYTES)).max(
  base64UrlLength(LIMITS.encAttachmentMetaBytes),
);
export type EncAttachmentMeta = z.infer<typeof EncAttachmentMeta>;

/**
 * A wrapped key: a workspace key sealed for a recipient's public key, or an account secret key
 * wrapped by the master key or the recovery key. Every field holding one is named `enc*`.
 */
export const EncKey = Base64Url.min(base64UrlLength(32)).max(base64UrlLength(512));
export type EncKey = z.infer<typeof EncKey>;

/**
 * A whole note version's envelope as base64url, in a JSON body (`getVersions`); at most
 * `LIMITS.noteBytes`. Every field holding one is named `ciphertext`.
 */
export const NoteCiphertext = Base64Url.min(base64UrlLength(ENVELOPE_OVERHEAD_BYTES)).max(
  base64UrlLength(LIMITS.noteBytes),
);
export type NoteCiphertext = z.infer<typeof NoteCiphertext>;

/** Every schema that carries ciphertext; the tests hold each one to an `enc*` or `ciphertext` key. */
export const CIPHERTEXT_SCHEMAS: readonly z.ZodType[] = [
  Ciphertext,
  EncName,
  EncAttachmentMeta,
  EncKey,
  NoteCiphertext,
];

/** An X25519 or Ed25519 public key (32 bytes). Public keys are not secret. */
export const PublicKey = Base64Url.length(base64UrlLength(32));
export type PublicKey = z.infer<typeof PublicKey>;

/** A detached Ed25519 signature (64 bytes). */
export const Signature = Base64Url.length(base64UrlLength(64));
export type Signature = z.infer<typeof Signature>;

/** A hash the server stores and compares (login hash, recovery auth hash): 16 to 64 bytes. */
export const AuthHash = Base64Url.min(base64UrlLength(16)).max(base64UrlLength(64));
export type AuthHash = z.infer<typeof AuthHash>;
