// Values for the tests: valid IDs and base64url strings of a given byte length.
import { formatId, type IdPrefix } from "./ids.js";
import { base64UrlLength } from "./primitives.js";

export function id<const P extends IdPrefix>(prefix: P, seed = 1): `${P}_${string}` {
  return formatId(prefix, new Uint8Array(16).fill(seed));
}

/** A base64url string as long as the encoding of `bytes` bytes. */
export function b64(bytes: number): string {
  return "Ab-_".repeat(Math.ceil(bytes / 3) + 1).slice(0, base64UrlLength(bytes));
}

/** A valid ciphertext field value (a small envelope). */
export const ct = b64(80);

export const now = "2026-09-30T12:00:00.000Z";

/** A valid `ciphertextSha256` for a signed envelope (64 lowercase hex characters). */
export const sha256Hex = "0123456789abcdef".repeat(4);

export const kdf = {
  algorithm: "argon2id13",
  salt: b64(16),
  opsLimit: 3,
  memLimitBytes: 64 * 1024 * 1024,
} as const;

/** Wrapped account keys: version, nonce, both secrets and the tag (105 bytes). */
export const wrappedSecretKeys = { encSecretKeys: b64(105) };

export const keyMaterial = {
  kdf,
  publicKeys: { box: b64(32), sign: b64(32) },
  wrappedByMaster: wrappedSecretKeys,
  wrappedByRecovery: wrappedSecretKeys,
  recoveryAuthHash: b64(32),
};

/** A signed `wrapped_key` record for a key sealed for the public key `recipient`. */
export function signedWrappedKey(recipient = b64(32), generation = 1) {
  return {
    envelope: {
      type: "wrapped_key",
      accountId: id("acc"),
      workspaceId: id("ws"),
      recipient,
      holder: "account",
      generation,
      ciphertextSha256: sha256Hex,
      createdAt: now,
    },
    signature: b64(64),
  };
}

/** The owner's signed `key_generation` record for `generation`. */
export function signedGeneration(generation = 1) {
  return {
    envelope: {
      type: "key_generation",
      accountId: id("acc"),
      workspaceId: id("ws"),
      generation,
      recipientsHash: "0".repeat(64),
      keyCommitment: "1".repeat(64),
      createdAt: now,
    },
    signature: b64(64),
  };
}

export const signing = { signedAt: now, signature: b64(64) };

/** The signing fields of a new key generation. */
export const generationSigning = {
  keyCommitment: "1".repeat(64),
  generationSignedAt: now,
  generationSignature: b64(64),
};
