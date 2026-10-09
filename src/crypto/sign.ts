import { type JsonObject, canonicalJson } from "./canonical-json.js";
import { fromBase64Url, toBase64Url, utf8Encode } from "./encoding.js";
import type { SigningKeyPair } from "./keys.js";
import { sodium } from "./sodium.js";
import { assertBytes } from "./validate.js";

// Signed events: a person's approvals, edits and comments carry an Ed25519 signature by their
// account signing key, which agents never hold, so an agent with the workspace key can't forge a
// human action. The signed message is
//
//   UTF-8 of "knowtarium-event-v1\n" + canonical JSON of the event
//
// The prefix keeps these signatures from being valid for anything else the key might sign later.

/** The signed event format this SDK writes and verifies. */
export const SIGNED_EVENT_VERSION = 1;

const SIGNATURE_BYTES = 64;
const DOMAIN = "knowtarium-event-v1\n";

/** An event and its signature, ready to be encrypted and stored next to what it refers to. */
export interface SignedEvent<T extends JsonObject = JsonObject> {
  readonly version: typeof SIGNED_EVENT_VERSION;
  /** The event as signed. Its fields are up to the caller (type, actor, note id, version, time). */
  readonly event: T;
  /** Ed25519 signature over the signed message, base64url (64 bytes). */
  readonly signature: string;
}

/** The exact bytes an event's signature covers. Throws `non_canonical_json` for a non-JSON event. */
export function signedEventMessage(event: JsonObject): Uint8Array {
  return utf8Encode(DOMAIN + canonicalJson(event));
}

/** Signs `event` with the account signing key. */
export function signEvent<T extends JsonObject>(
  event: T,
  signingKey: SigningKeyPair,
): SignedEvent<T> {
  assertBytes(signingKey.privateKey, 64, "Ed25519 private key");
  const signature = sodium().crypto_sign_detached(signedEventMessage(event), signingKey.privateKey);
  return { version: SIGNED_EVENT_VERSION, event, signature: toBase64Url(signature) };
}

/**
 * Whether `signed` carries a valid signature by `signerPublicKey`, the public signing key the
 * server holds for the person the event names. Never trust a key that arrives with the event.
 * Returns false for a malformed event or signature, so it is safe on decrypted, untrusted data (it
 * throws only for a malformed public key, a caller bug).
 */
export function verifyEvent(signed: SignedEvent, signerPublicKey: Uint8Array): boolean {
  const lib = sodium();
  assertBytes(signerPublicKey, 32, "Ed25519 public key");
  try {
    // `signed` is often decrypted, untrusted data: check its shape, not just its type
    const { version, signature: text } = signed as { version: unknown; signature: unknown };
    if (version !== SIGNED_EVENT_VERSION || typeof text !== "string") return false;
    const signature = fromBase64Url(text);
    if (signature.length !== SIGNATURE_BYTES) return false;
    return lib.crypto_sign_verify_detached(
      signature,
      signedEventMessage(signed.event),
      signerPublicKey,
    );
  } catch {
    return false;
  }
}
