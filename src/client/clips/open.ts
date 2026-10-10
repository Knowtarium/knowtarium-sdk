import {
  clipSignatureValid,
  type ClipPlaintext,
  parseClipPlaintext,
  readClipJson,
  readSealedClipHeader,
  SEALED_CLIP_HEADER_BYTES,
} from "../../clip/frame.js";
import { CLIP_FORMAT_VERSION, CLIP_LIMITS, type ClipPayload } from "../../clip/payload.js";
import { type InboxKeyPair, wipe } from "../../crypto/index.js";
import { sodium } from "../../crypto/sodium.js";

/*
 * Opening a sealed clip: the one place a clip is decrypted. Only a holder of the clip's key
 * generation derives its inbox private key (`deriveInboxKeyPair`), so only the web app and agents
 * with that generation can. The filer (`fileClips`) then checks what the clip names against its
 * queue entry and the extension's signature against the owner-vouched key.
 */

/** Why a filer refuses a clip (it is acked, never retried). */
export type ClipRejection =
  /** The seal doesn't open with the inbox key, the padding or the version byte is wrong. */
  | "unreadable"
  /** The JSON isn't canonical, or `normalizeClip` would change it. */
  | "invalid_clip"
  /** The clip names another clip ID, extension or workspace than its queue entry. */
  | "mismatch"
  /** No owner-vouched key for its extension, or the signature doesn't verify under it. */
  | "bad_signature"
  /** Its extension was revoked before the clip was posted. */
  | "revoked";

/** A clip opened with its inbox key, not yet checked against its queue entry or signature. */
export interface OpenedClip {
  readonly payload: ClipPayload;
  /** The payload's canonical JSON exactly as signed (what a `clipped` record keeps). */
  readonly json: string;
  readonly signature: Uint8Array;
}

/**
 * Opens a sealed clip with the inbox key pair of its generation: the 5 header bytes (format 1 and
 * the generation, which must be the key pair's), `crypto_box_seal_open`, unpadding, the version
 * byte, then the payload's JSON, which must be canonical and clean (`normalizeClip` leaves it
 * unchanged). Never throws for bad bytes: the result says why.
 */
export function openClip(
  blob: Uint8Array,
  inboxKey: InboxKeyPair,
):
  | { readonly ok: true; readonly clip: OpenedClip }
  | { readonly ok: false; readonly reason: ClipRejection } {
  const unreadable = { ok: false, reason: "unreadable" } as const;
  let plaintext: ClipPlaintext;
  try {
    if (blob.length > CLIP_LIMITS.sealedBytes) return unreadable;
    const header = readSealedClipHeader(blob);
    if (header.version !== CLIP_FORMAT_VERSION || header.generation !== inboxKey.generation) {
      return unreadable;
    }
    const lib = sodium();
    const padded = lib.crypto_box_seal_open(
      blob.subarray(SEALED_CLIP_HEADER_BYTES),
      inboxKey.publicKey,
      inboxKey.privateKey,
    );
    let unpadded: Uint8Array;
    try {
      unpadded = lib.unpad(padded, CLIP_LIMITS.padBlockBytes);
    } finally {
      wipe(padded);
    }
    plaintext = parseClipPlaintext(unpadded);
  } catch {
    return unreadable;
  }
  try {
    const payload = readClipJson(plaintext.json);
    return { ok: true, clip: { payload, json: plaintext.json, signature: plaintext.signature } };
  } catch {
    return { ok: false, reason: "invalid_clip" };
  }
}

/** Whether a clip's signature verifies under an extension's Ed25519 public key. */
export function clipSignedBy(clip: OpenedClip, signPublicKey: Uint8Array): boolean {
  return clipSignatureValid(sodium(), clip.payload, clip.signature, signPublicKey);
}
