import { aeadDecrypt, aeadEncrypt, NONCE_BYTES, TAG_BYTES } from "./aead.js";
import { concatBytes, readUint32BE, uint32BE, utf8Decode, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";
import {
  type AccountKeys,
  type AccountPublicKeys,
  type BoxKeyPair,
  boxKeyPairFromPrivateKey,
  KEY_PAIR_SEED_BYTES,
  signingKeyPairFromSeed,
} from "./keys.js";
import { sodium, wipe } from "./sodium.js";
import { assertBytes } from "./validate.js";
import { assertWorkspaceKey, WORKSPACE_KEY_BYTES, type WorkspaceKey } from "./workspace-keys.js";

// Key wrapping.
//
// Account keys (symmetric, with a key-encryption key from the password or the recovery key):
//   wrapVersion (1 byte, 0x01) || nonce (24) || XChaCha20-Poly1305(encryption private key || signing seed)
//   associated data: wrapVersion || "knowtarium account keys " || purpose ("password" or "recovery")
//
// Workspace keys (to a recipient's X25519 public key, with a libsodium sealed box):
//   crypto_box_seal(wrapVersion (0x01) || key generation (uint32 BE) || key (32) || UTF-8 workspace id)
//   The generation and workspace id sit inside the box, so the server can't relabel a wrapped key
//   as another generation or hand one workspace's key out as another's.

/** Format version of wrapped account keys and wrapped workspace keys. */
export const WRAP_FORMAT_VERSION = 1;

/** Which secret wrapped a copy of the account keys. The server stores one copy of each. */
export type AccountKeysWrapPurpose = "password" | "recovery";

const ACCOUNT_SECRETS_BYTES = 2 * KEY_PAIR_SEED_BYTES;
const WRAPPED_ACCOUNT_KEYS_BYTES = 1 + NONCE_BYTES + ACCOUNT_SECRETS_BYTES + TAG_BYTES;

/**
 * Encrypts the account's two private keys with a key-encryption key (from `derivePasswordSecrets`
 * or `deriveRecoverySecrets`), with a fresh random nonce.
 */
export function wrapAccountKeys(
  keys: AccountKeys,
  keyEncryptionKey: Uint8Array,
  purpose: AccountKeysWrapPurpose,
): Uint8Array {
  return wrapAccountKeysWithNonce(keys, keyEncryptionKey, purpose, undefined);
}

/** `wrapAccountKeys` with a chosen nonce, for the test vectors only (not exported by the package). */
export function wrapAccountKeysWithNonce(
  keys: AccountKeys,
  keyEncryptionKey: Uint8Array,
  purpose: AccountKeysWrapPurpose,
  nonce: Uint8Array | undefined,
): Uint8Array {
  assertBytes(keys.encryption.privateKey, KEY_PAIR_SEED_BYTES, "X25519 private key");
  assertBytes(keys.signing.privateKey, 64, "Ed25519 private key");
  const secrets = concatBytes(
    keys.encryption.privateKey,
    keys.signing.privateKey.subarray(0, KEY_PAIR_SEED_BYTES),
  );
  try {
    const sealed = aeadEncrypt(keyEncryptionKey, secrets, accountKeysAD(purpose), nonce);
    return concatBytes(Uint8Array.of(WRAP_FORMAT_VERSION), sealed.nonce, sealed.ciphertext);
  } finally {
    wipe(secrets);
  }
}

/**
 * Decrypts wrapped account keys and checks they belong to `expected`, the public keys on record
 * for the account (`key_mismatch` otherwise), so a server can't hand out another keypair it
 * wrapped under a key it tricked the client into deriving. Throws `decryption_failed` for a wrong
 * key-encryption key or tampered bytes.
 */
export function unwrapAccountKeys(
  wrapped: Uint8Array,
  keyEncryptionKey: Uint8Array,
  purpose: AccountKeysWrapPurpose,
  expected: AccountPublicKeys,
): AccountKeys {
  if (wrapped.length !== WRAPPED_ACCOUNT_KEYS_BYTES) {
    throw new CryptoError("malformed_envelope", "wrapped account keys have the wrong length");
  }
  assertWrapVersion(wrapped[0]);
  const secrets = aeadDecrypt(
    keyEncryptionKey,
    wrapped.subarray(1 + NONCE_BYTES),
    accountKeysAD(purpose),
    wrapped.subarray(1, 1 + NONCE_BYTES),
  );
  try {
    const keys: AccountKeys = {
      encryption: boxKeyPairFromPrivateKey(secrets.subarray(0, KEY_PAIR_SEED_BYTES)),
      signing: signingKeyPairFromSeed(secrets.subarray(KEY_PAIR_SEED_BYTES)),
    };
    if (
      !sameBytes(keys.encryption.publicKey, expected.encryptionPublicKey) ||
      !sameBytes(keys.signing.publicKey, expected.signingPublicKey)
    ) {
      wipe(keys.encryption.privateKey, keys.signing.privateKey);
      throw new CryptoError("key_mismatch", "the unwrapped keys don't match the account");
    }
    return keys;
  } finally {
    wipe(secrets);
  }
}

/**
 * Wraps a workspace key for one recipient (the account, an agent or the enclave) with a sealed
 * box to its X25519 public key. `workspaceId` is bound inside the box and checked on unwrap.
 */
export function wrapWorkspaceKey(
  key: WorkspaceKey,
  recipientPublicKey: Uint8Array,
  workspaceId: string,
): Uint8Array {
  assertWorkspaceKey(key);
  assertBytes(recipientPublicKey, KEY_PAIR_SEED_BYTES, "recipient public key");
  const payload = concatBytes(
    Uint8Array.of(WRAP_FORMAT_VERSION),
    uint32BE(key.generation),
    key.key,
    utf8Encode(workspaceId),
  );
  try {
    return sodium().crypto_box_seal(payload, recipientPublicKey);
  } finally {
    wipe(payload);
  }
}

/**
 * Opens a workspace key wrapped for `recipient`, without checking who wrapped it. Internal: the
 * package exports only `unwrapSignedWorkspaceKey`, which verifies the owner's signature first. Throws `decryption_failed` if it was wrapped for
 * another key or tampered with, and `key_mismatch` if it belongs to another workspace.
 */
export function unwrapWorkspaceKeyUnverified(
  wrapped: Uint8Array,
  recipient: BoxKeyPair,
  workspaceId: string,
): WorkspaceKey {
  assertBytes(recipient.publicKey, KEY_PAIR_SEED_BYTES, "recipient public key");
  assertBytes(recipient.privateKey, KEY_PAIR_SEED_BYTES, "recipient private key");
  let payload: Uint8Array;
  try {
    payload = sodium().crypto_box_seal_open(wrapped, recipient.publicKey, recipient.privateKey);
  } catch {
    throw new CryptoError("decryption_failed", "decryption failed: wrong key or tampered data");
  }
  try {
    const keyEnd = 5 + WORKSPACE_KEY_BYTES;
    if (payload.length < keyEnd) {
      throw new CryptoError("malformed_envelope", "a wrapped workspace key is too short");
    }
    assertWrapVersion(payload[0]);
    if (utf8Decode(payload.subarray(keyEnd)) !== workspaceId) {
      throw new CryptoError("key_mismatch", "the wrapped key belongs to another workspace");
    }
    return { generation: readUint32BE(payload, 1), key: payload.slice(5, keyEnd) };
  } finally {
    wipe(payload);
  }
}

function accountKeysAD(purpose: AccountKeysWrapPurpose): Uint8Array {
  return concatBytes(
    Uint8Array.of(WRAP_FORMAT_VERSION),
    utf8Encode(`knowtarium account keys ${purpose}`),
  );
}

function assertWrapVersion(version: number | undefined): void {
  if (version !== WRAP_FORMAT_VERSION) {
    throw new CryptoError("unsupported_version", "unsupported wrapped key format version");
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && sodium().memcmp(a, b);
}
