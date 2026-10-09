import { concatBytes, toHex, uint32BE, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { sodium } from "./sodium.js";
import type { WorkspaceKey } from "./workspace-keys.js";

/** SHA-256 of `bytes` (libsodium `crypto_hash_sha256`), 32 bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return sodium().crypto_hash_sha256(bytes);
}

/**
 * SHA-256 of an uploaded ciphertext (an envelope) as 64 lowercase hex characters: the
 * `ciphertextSha256` of a signed envelope. The server can compute the same value from the bytes it
 * receives (Web Crypto `SHA-256`) without any key.
 */
export function ciphertextSha256(ciphertext: Uint8Array): string {
  return toHex(sha256(ciphertext));
}

/** The domain tag `workspaceKeyCommitment` hashes first. */
export const KEY_COMMITMENT_TAG = "knowtarium-key-commitment-v1\n";

/**
 * The commitment to a workspace key generation, as 64 lowercase hex characters: the
 * `keyCommitment` of a signed "key_generation". SHA-256 of the UTF-8 tag
 * "knowtarium-key-commitment-v1\n", the generation (uint32 big-endian), the 32-byte key and the
 * UTF-8 workspace id. Anyone holding the key (the owner's browsers, the CLI) can check that the
 * key they unwrapped is the one the owner signed for that generation, so a server holding two
 * owner-signed key sets for one generation can't serve the other one unnoticed. It reveals
 * nothing about a random 256-bit key.
 */
export function workspaceKeyCommitment(key: WorkspaceKey, workspaceId: string): string {
  if (!(key.key instanceof Uint8Array) || key.key.length !== 32) {
    throw new CryptoError("invalid_input", "a workspace key is 32 bytes");
  }
  return toHex(
    sha256(
      concatBytes(
        utf8Encode(KEY_COMMITMENT_TAG),
        uint32BE(key.generation),
        key.key,
        utf8Encode(workspaceId),
      ),
    ),
  );
}

/** The domain tag `recipientsHash` hashes first. */
export const RECIPIENTS_HASH_TAG = "knowtarium-recipients-v1\n";

/**
 * The SHA-256 of a key generation's recipient set, as 64 lowercase hex characters (the
 * `recipientsHash` of a signed "key_generation"): SHA-256 of the UTF-8 tag
 * "knowtarium-recipients-v1\n" followed by the X25519 public keys (32 bytes each), deduplicated,
 * sorted by their bytes, each prefixed by its length (uint32 big-endian). The server computes the same from the public keys it stores, without any key.
 */
export function recipientsHash(publicKeys: readonly Uint8Array[]): string {
  const unique = new Map<string, Uint8Array>();
  for (const key of publicKeys) {
    if (!(key instanceof Uint8Array) || key.length !== 32) {
      throw new CryptoError("invalid_input", "a recipient public key is 32 bytes");
    }
    unique.set(toHex(key), key);
  }
  const sorted = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return toHex(
    sha256(
      concatBytes(
        utf8Encode(RECIPIENTS_HASH_TAG),
        ...sorted.flatMap(([, key]) => [uint32BE(key.length), key]),
      ),
    ),
  );
}
