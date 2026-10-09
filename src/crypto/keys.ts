import { concatBytes, toBase32, utf8Encode } from "./encoding.js";
import { sodium } from "./sodium.js";
import { assertBytes } from "./validate.js";

// Asymmetric keys: the account's X25519 encryption keypair and Ed25519 signing keypair, and the
// X25519 and Ed25519 keypairs each connected agent (the knowtarium CLI) creates for itself.

/** An X25519 keypair: receives workspace keys wrapped in sealed boxes. */
export interface BoxKeyPair {
  /** 32 bytes, safe to share. */
  readonly publicKey: Uint8Array;
  /** 32 bytes, never leaves the device unwrapped. */
  readonly privateKey: Uint8Array;
}

/** An Ed25519 keypair: signs a person's approvals, edits and comments. */
export interface SigningKeyPair {
  /** 32 bytes, safe to share. */
  readonly publicKey: Uint8Array;
  /** 64 bytes in libsodium's layout (32-byte seed, then the public key). */
  readonly privateKey: Uint8Array;
}

/** Everything an unlocked account holds. Agents never get the signing key. */
export interface AccountKeys {
  readonly encryption: BoxKeyPair;
  readonly signing: SigningKeyPair;
}

/** The public halves of the account keys, stored on the server in the clear. */
export interface AccountPublicKeys {
  readonly encryptionPublicKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
}

/** Bytes in an X25519 key and in an Ed25519 public key or seed. */
export const KEY_PAIR_SEED_BYTES = 32;

/** New random account keys, created once at sign-up. */
export function createAccountKeys(): AccountKeys {
  const lib = sodium();
  const encryption = lib.crypto_box_keypair();
  const signing = lib.crypto_sign_keypair();
  return {
    encryption: { publicKey: encryption.publicKey, privateKey: encryption.privateKey },
    signing: { publicKey: signing.publicKey, privateKey: signing.privateKey },
  };
}

/** The public keys of `keys`, as the server stores them. */
export function accountPublicKeys(keys: AccountKeys): AccountPublicKeys {
  return {
    encryptionPublicKey: keys.encryption.publicKey,
    signingPublicKey: keys.signing.publicKey,
  };
}

/** Rebuilds an X25519 keypair from its 32-byte private key (for example, read from a keychain). */
export function boxKeyPairFromPrivateKey(privateKey: Uint8Array): BoxKeyPair {
  assertBytes(privateKey, KEY_PAIR_SEED_BYTES, "X25519 private key");
  return {
    publicKey: sodium().crypto_scalarmult_base(privateKey),
    privateKey: privateKey.slice(),
  };
}

/** Rebuilds an Ed25519 keypair from its 32-byte seed. */
export function signingKeyPairFromSeed(seed: Uint8Array): SigningKeyPair {
  assertBytes(seed, KEY_PAIR_SEED_BYTES, "Ed25519 seed");
  const { publicKey, privateKey } = sodium().crypto_sign_seed_keypair(seed);
  return { publicKey, privateKey };
}

/** A new X25519 keypair for a connected agent. The CLI creates it locally and keeps the private key. */
export function createAgentKeyPair(): BoxKeyPair {
  const { publicKey, privateKey } = sodium().crypto_box_keypair();
  return { publicKey, privateKey };
}

/**
 * A new Ed25519 keypair for a connected agent (protocol 2): the CLI creates it locally at connect
 * time, keeps the private key and sends the public half in the connect fragment; it signs only
 * the agent's direct writes (`agent_edited`), once the owner vouched for it (`agent_key`).
 */
export function createAgentSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = sodium().crypto_sign_keypair();
  return { publicKey, privateKey };
}

const CONFIRMATION_KEY = "knowtarium connect confirmation v1";

/**
 * The code the terminal and the browser both show during `knowtarium connect`, as a visual check
 * on top of the authenticated payload (connect.ts): the first 40 bits of BLAKE2b-256 of the CLI's
 * X25519 public key followed by the owner's Ed25519 signing public key (keyed with
 * "knowtarium connect confirmation v1"), as 8 Crockford base32 characters shown as "ABCD-EFGH".
 * A server that swapped either key would have to find a collision on 40 bits within the minutes a
 * connect request lives.
 */
export function connectConfirmationCode(
  cliPublicKey: Uint8Array,
  ownerSigningPublicKey: Uint8Array,
): string {
  assertBytes(cliPublicKey, KEY_PAIR_SEED_BYTES, "CLI public key");
  assertBytes(ownerSigningPublicKey, KEY_PAIR_SEED_BYTES, "owner signing public key");
  const digest = sodium().crypto_generichash(
    32,
    concatBytes(cliPublicKey, ownerSigningPublicKey),
    utf8Encode(CONFIRMATION_KEY),
  );
  const code = toBase32(digest.subarray(0, 5));
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
