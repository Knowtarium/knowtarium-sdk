import { CryptoError } from "./errors.js";
import { sodium } from "./sodium.js";
import { assertBytes } from "./validate.js";

// XChaCha20-Poly1305 (IETF) with a random 24-byte nonce: the one symmetric cipher of the SDK.

/** Bytes in an XChaCha20-Poly1305 key. */
export const KEY_BYTES = 32;
/** Bytes in an XChaCha20-Poly1305 nonce. */
export const NONCE_BYTES = 24;
/** Bytes the Poly1305 tag adds to the ciphertext. */
export const TAG_BYTES = 16;

/**
 * Encrypts `plaintext` bound to `associatedData`. The nonce is random unless one is passed, which
 * only the test vectors do: reusing a nonce with the same key breaks the cipher.
 */
export function aeadEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
  nonce: Uint8Array = sodium().randombytes_buf(NONCE_BYTES),
): { nonce: Uint8Array; ciphertext: Uint8Array } {
  assertBytes(key, KEY_BYTES, "key");
  assertBytes(nonce, NONCE_BYTES, "nonce");
  const ciphertext = sodium().crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData,
    null,
    nonce,
    key,
  );
  return { nonce, ciphertext };
}

/** Decrypts and authenticates, or throws `decryption_failed`. */
export function aeadDecrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  assertBytes(key, KEY_BYTES, "key");
  assertBytes(nonce, NONCE_BYTES, "nonce");
  try {
    return sodium().crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      associatedData,
      nonce,
      key,
    );
  } catch {
    throw new CryptoError("decryption_failed", "decryption failed: wrong key or tampered data");
  }
}
