// `knowtarium/clip`: the light entry the web clipper extension imports. It cleans, signs and seals
// a clip to the workspace's inbox key, makes the extension's keys and pairing secret, shows the
// pairing code and checks the owner-signed keys. It opens nothing but the pairing payload under
// its one-time secret: no clip, note or workspace key copy (those are knowtarium/client's). It
// runs on the standard libsodium-wrappers build, not the sumo one. Await `ready()` once.

import { signAndSealClipWith, type InboxPublicKey } from "./frame.js";
import {
  type ExtensionKeys,
  extensionConfirmationCodeWith,
  extensionKeyValid,
  inboxKeyValid,
  type SignedExtensionKey,
  type SignedInboxKey,
} from "./keys.js";
import {
  type ExtensionPairing,
  openExtensionPairingWith,
  PAIRING_SECRET_BYTES,
} from "./pairing.js";
import { type ClipInput, formatClipId } from "./payload.js";
import { sodium } from "./sodium.js";

export { ready } from "./sodium.js";
export { fromBase64Url, toBase64Url } from "../crypto/encoding.js";
export { ClipError, type ClipErrorCode, isClipError } from "./errors.js";
export {
  CLIP_FORMAT_VERSION,
  CLIP_LIMITS,
  type ClipInput,
  type ClipPayload,
  normalizeCategory,
  normalizeClip,
} from "./payload.js";
export type { InboxPublicKey } from "./frame.js";
export type { ExtensionKeys, SignedExtensionKey, SignedInboxKey } from "./keys.js";
export { type ExtensionPairing, formatExtensionConnectFragment } from "./pairing.js";
export * from "./routes.js";

/** A new Ed25519 key pair for the extension, made in pair.html when pairing starts. */
export function createExtensionKeys(): ExtensionKeys {
  const { publicKey, privateKey } = sodium().crypto_sign_keypair();
  return { publicKey, privateKey };
}

/** A new one-time pairing secret (32 random bytes), put in the pairing link's fragment. */
export function createConnectSecret(): Uint8Array {
  return sodium().randombytes_buf(PAIRING_SECRET_BYTES);
}

/** A new clip ID (`clip_` and 16 random bytes), one per saved clip. */
export function createClipId(): string {
  return formatClipId(sodium().randombytes_buf(16));
}

/**
 * The pairing code (`ABCD-EFGH`) over the extension's signing public key and the connect
 * request's ID; pair.html shows it at once and the web app shows it before Allow.
 */
export function extensionConfirmationCode(signPublicKey: Uint8Array, requestId: string): string {
  return extensionConfirmationCodeWith(sodium(), signPublicKey, requestId);
}

/**
 * Opens and checks the relayed pairing payload (see `ExtensionPairing`): `bad_payload`,
 * `wrong_key` or `bad_signature` when it isn't one to trust; forget the token then.
 */
export function openExtensionPairing(
  sealed: Uint8Array,
  link: { readonly secret: Uint8Array; readonly signPublicKey: Uint8Array },
): ExtensionPairing {
  return openExtensionPairingWith(sodium(), sealed, link);
}

/**
 * Whether to accept an `inbox_key` (from `getExtensionInboxKey` or a `stale_inbox_key` answer):
 * signed by the pinned owner key for the paired account and workspace, at `minRevision` or above
 * (the highest verified so far plus one) and not below `minGeneration` (the highest generation
 * verified so far), so a server can't move the extension back to an older key.
 */
export function verifyInboxKey(
  signed: SignedInboxKey,
  expected: {
    readonly ownerSigningPublicKey: Uint8Array;
    readonly accountId: string;
    readonly workspaceId: string;
    readonly minRevision: number;
    readonly minGeneration: number;
  },
): boolean {
  return inboxKeyValid(sodium(), signed, expected);
}

/** Whether an `extension_key` vouches for exactly this extension's ID and key under the owner. */
export function verifyExtensionKey(
  signed: SignedExtensionKey,
  expected: {
    readonly ownerSigningPublicKey: Uint8Array;
    readonly accountId: string;
    readonly workspaceId: string;
    readonly extensionId: string;
    readonly signPublicKey: Uint8Array | string;
  },
): boolean {
  return extensionKeyValid(sodium(), signed, expected);
}

/**
 * Cleans the payload (`normalizeClip`), signs it with the extension's secret key, pads it to 1 KiB
 * steps and seals it to the inbox key: `0x01 ‖ generation ‖ crypto_box_seal(...)`, at most 24
 * KiB. Send it as `blob` (base64url) with the payload's `clipId`.
 *
 * Queue the payload (with its `clipId` and `savedAt` fixed) and the sealed bytes. Ed25519 is
 * deterministic, so signing the same payload again gives the same signature, but each seal is
 * new bytes: retry a failed send (network, 5xx, 404, 429) with the SAME sealed bytes, since the
 * API answers a clip ID it holds with other bytes 409 `already_exists`; seal again only after
 * `stale_inbox_key` (the API kept nothing then), with the new inbox key.
 */
export function signAndSealClip(
  payload: ClipInput,
  options: { readonly signingSecretKey: Uint8Array; readonly inboxKey: InboxPublicKey },
): Uint8Array {
  return signAndSealClipWith(sodium(), payload, options);
}
