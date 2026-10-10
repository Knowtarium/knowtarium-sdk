import { fromBase64Url, toBase32, utf8Encode, concatBytes } from "../crypto/encoding.js";
import {
  SIGNATURE_BYTES,
  type SignedEnvelopeFields,
  signedEnvelopeMessage,
} from "../crypto/envelope-fields.js";
import { ClipError } from "./errors.js";
import type { ClipSodium } from "./lib.js";

// The owner-signed keys the extension trusts, under the owner's signing key it pinned from the
// sealed pairing payload (never from a server answer): `inbox_key` (the public key clips are
// sealed to) and `extension_key` (its own signing key, vouched for). Both are ordinary signed
// envelopes ("knowtarium-envelope-v1\n" and canonical JSON), checked with the same field rules as
// knowtarium/crypto (envelope-fields.ts).

/** A signed `inbox_key`, as the API serves it (`getExtensionInboxKey`, `stale_inbox_key`). */
export interface SignedInboxKey {
  readonly envelope: {
    readonly type: "inbox_key";
    readonly accountId: string;
    readonly workspaceId: string;
    readonly createdAt: string;
    readonly revision: number;
    readonly generation: number;
    /** The inbox X25519 public key, base64url. */
    readonly publicKey: string;
    readonly folderId: string;
  };
  readonly signature: string;
}

/** A signed `extension_key`: the owner vouching for the extension's Ed25519 key. */
export interface SignedExtensionKey {
  readonly envelope: {
    readonly type: "extension_key";
    readonly accountId: string;
    readonly workspaceId: string;
    readonly createdAt: string;
    readonly extensionId: string;
    /** The extension's Ed25519 public key, base64url. */
    readonly signPublicKey: string;
  };
  readonly signature: string;
}

/** An Ed25519 key pair in libsodium's layout (64-byte secret key). */
export interface ExtensionKeys {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** Whether `signature` (base64url) verifies `fields` under `publicKey`; false for any malformation. */
export function envelopeSignatureValid(
  lib: Pick<ClipSodium, "crypto_sign_verify_detached">,
  fields: SignedEnvelopeFields,
  signature: unknown,
  publicKey: Uint8Array,
): boolean {
  if (typeof signature !== "string" || publicKey.length !== 32) return false;
  try {
    const bytes = fromBase64Url(signature);
    if (bytes.length !== SIGNATURE_BYTES) return false;
    return lib.crypto_sign_verify_detached(bytes, signedEnvelopeMessage(fields), publicKey);
  } catch {
    return false;
  }
}

/** The envelope's own fields only, so an extra field fails the signature instead of riding along. */
function fieldsOf(envelope: unknown): SignedEnvelopeFields | null {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return null;
  return envelope as SignedEnvelopeFields;
}

/**
 * Whether an `inbox_key` is one to accept: signed by the pinned owner key, for the paired account
 * and workspace, at revision `minRevision` or above (pass the highest revision verified so far
 * plus one for a newer key) and, with `minGeneration`, not for an older key generation.
 */
export function inboxKeyValid(
  lib: Pick<ClipSodium, "crypto_sign_verify_detached">,
  signed: SignedInboxKey,
  expected: {
    readonly ownerSigningPublicKey: Uint8Array;
    readonly accountId: string;
    readonly workspaceId: string;
    readonly minRevision: number;
    readonly minGeneration?: number;
  },
): boolean {
  const fields = fieldsOf((signed as { envelope?: unknown } | null)?.envelope);
  if (fields === null) return false;
  const { type, accountId, workspaceId, revision, generation } = fields;
  return (
    type === "inbox_key" &&
    accountId === expected.accountId &&
    workspaceId === expected.workspaceId &&
    typeof revision === "number" &&
    revision >= Math.max(1, expected.minRevision) &&
    typeof generation === "number" &&
    generation >= (expected.minGeneration ?? 1) &&
    envelopeSignatureValid(lib, fields, signed.signature, expected.ownerSigningPublicKey)
  );
}

/**
 * Whether an `extension_key` vouches, under the owner key, for exactly this extension's ID and
 * public key in the paired account and workspace.
 */
export function extensionKeyValid(
  lib: Pick<ClipSodium, "crypto_sign_verify_detached">,
  signed: SignedExtensionKey,
  expected: {
    readonly ownerSigningPublicKey: Uint8Array;
    readonly accountId: string;
    readonly workspaceId: string;
    readonly extensionId: string;
    readonly signPublicKey: Uint8Array | string;
  },
): boolean {
  const fields = fieldsOf((signed as { envelope?: unknown } | null)?.envelope);
  if (fields === null) return false;
  let signPublicKey: Uint8Array;
  try {
    signPublicKey =
      typeof expected.signPublicKey === "string"
        ? fromBase64Url(expected.signPublicKey)
        : expected.signPublicKey;
  } catch {
    return false;
  }
  return (
    fields.type === "extension_key" &&
    fields.accountId === expected.accountId &&
    fields.workspaceId === expected.workspaceId &&
    fields.extensionId === expected.extensionId &&
    typeof fields.signPublicKey === "string" &&
    sameBytes(fields.signPublicKey, signPublicKey) &&
    envelopeSignatureValid(lib, fields, signed.signature, expected.ownerSigningPublicKey)
  );
}

function sameBytes(base64Url: string, bytes: Uint8Array): boolean {
  try {
    const decoded = fromBase64Url(base64Url);
    return decoded.length === bytes.length && decoded.every((byte, i) => byte === bytes[i]);
  } catch {
    return false;
  }
}

const CONFIRMATION_KEY = "knowtarium extension confirmation v1";

/**
 * The code the extension shows as soon as pairing starts, and the web app before Allow: the first
 * 40 bits of BLAKE2b-256 keyed with "knowtarium extension confirmation v1" over the extension's
 * Ed25519 public key followed by the UTF-8 request ID, as 8 Crockford base32 characters shown as
 * `ABCD-EFGH`. Both sides compute it from values they hold before anything is approved, so a
 * pairing link a phishing page opened shows a code no extension of the person's shows.
 */
export function extensionConfirmationCodeWith(
  lib: Pick<ClipSodium, "crypto_generichash">,
  signPublicKey: Uint8Array,
  requestId: string,
): string {
  if (!(signPublicKey instanceof Uint8Array) || signPublicKey.length !== 32) {
    throw new ClipError("invalid", "the extension's public key must be 32 bytes");
  }
  if (typeof requestId !== "string" || !/^cr_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(requestId)) {
    throw new ClipError("invalid", "not a connect request ID");
  }
  const digest = lib.crypto_generichash(
    32,
    concatBytes(signPublicKey, utf8Encode(requestId)),
    utf8Encode(CONFIRMATION_KEY),
  );
  const code = toBase32(digest.subarray(0, 5));
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
