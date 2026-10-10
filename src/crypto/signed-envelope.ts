import { fromBase64Url, toBase64Url } from "./encoding.js";
import {
  SIGNATURE_BYTES,
  SIGNED_ENVELOPE_VERSION,
  type SignedEnvelope,
  signedEnvelopeMessage,
  type SignedEnvelopeFields,
  type SignedEnvelopeType,
} from "./envelope-fields.js";
import type { SigningKeyPair } from "./keys.js";
import { sodium } from "./sodium.js";
import { assertBytes } from "./validate.js";

export {
  canonicalizeEnvelope,
  SIGNED_ENVELOPE_OPTIONAL,
  SIGNED_ENVELOPE_TOGETHER,
  SIGNED_ENVELOPE_TYPES,
  SIGNED_ENVELOPE_VERSION,
  type SignedEnvelope,
  signedEnvelopeMessage,
  type SignedEnvelopeFields,
  type SignedEnvelopeType,
  WRAPPED_KEY_ACCOUNT_HOLDER,
} from "./envelope-fields.js";

// Signed envelopes: the server-verifiable signature on a person's action, or, for "agent_edited",
// on an agent's direct write under the agent's own key (which the owner vouched for with
// "agent_key"). Where a signed event (sign.ts) travels inside encryption, a signed envelope covers
// only what the server may see (ids, versions, the SHA-256 of the ciphertext, a time), so the
// sync API can check with the signer's public key (Web Crypto Ed25519, no libsodium) that an
// approval, edit or comment really comes from the person (or the agent), and bind it to the exact
// ciphertext it stores.
//
// The signed message is the UTF-8 bytes of
//
//   "knowtarium-envelope-v1\n" + canonical JSON of the envelope fields
//
// The fields hold only strings and integers, so their canonical JSON is simply: keys sorted by
// UTF-16 code units, no whitespace, values as JSON.stringify writes them. Every type requires
// type, accountId, workspaceId and createdAt plus its own fields (SIGNED_ENVELOPE_TYPES), may have
// the few optional fields SIGNED_ENVELOPE_OPTIONAL lists, and nothing else, so the signer and the
// server (which rebuilds the envelope from the request) always agree on what was signed.
// envelope-vectors.json pins all of this for reimplementations and for knowtarium/protocol.

/** Signs envelope fields with the account signing key. */
export function signEnvelope(
  fields: SignedEnvelopeFields,
  signingKey: SigningKeyPair,
): SignedEnvelope {
  assertBytes(signingKey.privateKey, 64, "Ed25519 private key");
  const message = signedEnvelopeMessage(fields);
  const signature = sodium().crypto_sign_detached(message, signingKey.privateKey);
  return { version: SIGNED_ENVELOPE_VERSION, envelope: fields, signature: toBase64Url(signature) };
}

/**
 * Whether `signed` carries a valid signature by `signerPublicKey` (the signing key on record for
 * `envelope.accountId`). Returns false for malformed input; throws only for a malformed public key.
 * Checking that `ciphertextSha256` matches the uploaded bytes is up to the caller.
 */
export function verifyEnvelope(signed: SignedEnvelope, signerPublicKey: Uint8Array): boolean {
  const lib = sodium();
  assertBytes(signerPublicKey, 32, "Ed25519 public key");
  try {
    const { version, signature: text } = signed as { version: unknown; signature: unknown };
    if (version !== SIGNED_ENVELOPE_VERSION || typeof text !== "string") return false;
    const signature = fromBase64Url(text);
    if (signature.length !== SIGNATURE_BYTES) return false;
    return lib.crypto_sign_verify_detached(
      signature,
      signedEnvelopeMessage(signed.envelope),
      signerPublicKey,
    );
  } catch {
    return false;
  }
}

/**
 * `verifyEnvelope`, plus every field in `expected` must equal the signed one: pass what the
 * caller knows independently (type, account, workspace, note, version, hash of the bytes it
 * received, ...). The type is required, so a signature for one action never passes as another.
 */
export function verifyEnvelopeFor(
  signed: SignedEnvelope,
  signerPublicKey: Uint8Array,
  expected: Partial<SignedEnvelopeFields> & { readonly type: SignedEnvelopeType },
): boolean {
  if (!verifyEnvelope(signed, signerPublicKey)) return false;
  const fields = signed.envelope as unknown as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => fields[key] === value);
}
