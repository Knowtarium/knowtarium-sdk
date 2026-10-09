import { aeadDecrypt, aeadEncrypt, NONCE_BYTES } from "./aead.js";
import { concatBytes, fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { type BoxKeyPair, connectConfirmationCode, KEY_PAIR_SEED_BYTES } from "./keys.js";
import type { SignedEnvelope } from "./signed-envelope.js";
import { type SignedWrappedKey, unwrapSignedWorkspaceKey } from "./signed-wrap.js";
import { sodium, wipe } from "./sodium.js";
import { assertBytes } from "./validate.js";
import type { WorkspaceKey } from "./workspace-keys.js";

// The connect payload: how the browser hands the CLI its agent token, the owner's signing public
// key and the owner-signed wrapped workspace key, whether by a direct POST to the CLI's loopback
// port or relayed by the server when loopback is unreachable. Both paths carry the same bytes.
//
// The CLI puts a one-time 32-byte secret in the URL fragment of the connect link, which never
// reaches the server. Both sides derive a payload key from it (crypto_kdf, context "ktconnct",
// subkey id 1) and the payload is
//
//   0x01 || nonce (24) || XChaCha20-Poly1305(JSON { token, ownerSigningPublicKey, wrapped, signed,
//                                                   signedGeneration })
//   associated data: "knowtarium-connect-v1\n" || the CLI's X25519 public key
//
// so a relaying server can neither read nor forge it. The confirmation code over the CLI key and
// the owner key is a second, visual check.

/** Format version of a sealed connect payload. */
export const CONNECT_PAYLOAD_VERSION = 1;

/** Bytes of the one-time connect secret. */
export const CONNECT_SECRET_BYTES = 32;

/** What the browser sends the CLI once the user approves the connect request. */
export interface ConnectPayload {
  /** The agent token the server issued. */
  readonly token: string;
  /** The owner's Ed25519 public key; the CLI pins it to verify wrapped keys later. */
  readonly ownerSigningPublicKey: Uint8Array;
  /** The workspace key wrapped for the CLI, with the owner's signatures on it and its generation. */
  readonly signedWrappedKey: SignedWrappedKey;
}

/** What the CLI gets from a verified connect payload. */
export interface OpenedConnectPayload extends ConnectPayload {
  readonly ownerAccountId: string;
  readonly workspaceId: string;
  /** The unwrapped workspace key, verified to come from the owner. */
  readonly workspaceKey: WorkspaceKey;
  /** The code to show in the terminal; the user compares it with the browser's. */
  readonly confirmationCode: string;
}

/** A new one-time connect secret, created by the CLI and put in the connect link's fragment. */
export function createConnectSecret(): Uint8Array {
  return sodium().randombytes_buf(CONNECT_SECRET_BYTES);
}

/** Seals the payload for the CLI (browser side), with the secret from the connect link's fragment. */
export function sealConnectPayload(
  payload: ConnectPayload,
  link: { readonly secret: Uint8Array; readonly cliPublicKey: Uint8Array },
): Uint8Array {
  return sealConnectPayloadWithNonce(payload, link, undefined);
}

/** `sealConnectPayload` with a chosen nonce, for the test vectors only (not exported). */
export function sealConnectPayloadWithNonce(
  payload: ConnectPayload,
  link: { readonly secret: Uint8Array; readonly cliPublicKey: Uint8Array },
  nonce: Uint8Array | undefined,
): Uint8Array {
  assertBytes(payload.ownerSigningPublicKey, KEY_PAIR_SEED_BYTES, "owner signing public key");
  const json = JSON.stringify({
    token: payload.token,
    ownerSigningPublicKey: toBase64Url(payload.ownerSigningPublicKey),
    wrapped: toBase64Url(payload.signedWrappedKey.wrapped),
    signed: payload.signedWrappedKey.signed,
    signedGeneration: payload.signedWrappedKey.signedGeneration,
  });
  const key = payloadKey(link.secret);
  try {
    const sealed = aeadEncrypt(key, utf8Encode(json), associatedData(link.cliPublicKey), nonce);
    return concatBytes(Uint8Array.of(CONNECT_PAYLOAD_VERSION), sealed.nonce, sealed.ciphertext);
  } finally {
    wipe(key);
  }
}

/**
 * Opens and verifies a connect payload (CLI side): authenticates it with the secret the CLI put
 * in the link, then verifies the owner's signature on the wrapped key and unwraps it. Throws
 * `decryption_failed` for a payload the secret doesn't authenticate (forged or tampered),
 * `malformed_envelope` for a payload of the wrong shape and `invalid_signature` for a wrapped
 * key the owner didn't sign for this CLI.
 */
export function openConnectPayload(
  sealed: Uint8Array,
  cli: { readonly secret: Uint8Array; readonly keyPair: BoxKeyPair },
): OpenedConnectPayload {
  if (sealed.length < 1 + NONCE_BYTES) {
    throw new CryptoError("malformed_envelope", "the connect payload is too short");
  }
  if (sealed[0] !== CONNECT_PAYLOAD_VERSION) {
    throw new CryptoError("unsupported_version", "unsupported connect payload version");
  }
  const key = payloadKey(cli.secret);
  let plaintext: Uint8Array;
  try {
    plaintext = aeadDecrypt(
      key,
      sealed.subarray(1 + NONCE_BYTES),
      associatedData(cli.keyPair.publicKey),
      sealed.subarray(1, 1 + NONCE_BYTES),
    );
  } finally {
    wipe(key);
  }
  const payload = parsePayload(plaintext);
  wipe(plaintext);
  const { accountId, workspaceId } = payload.signedWrappedKey.signed.envelope;
  const workspaceKey = unwrapSignedWorkspaceKey(payload.signedWrappedKey, cli.keyPair, {
    ownerSigningPublicKey: payload.ownerSigningPublicKey,
    ownerAccountId: accountId,
    workspaceId,
  });
  return {
    ...payload,
    ownerAccountId: accountId,
    workspaceId,
    workspaceKey,
    confirmationCode: connectConfirmationCode(cli.keyPair.publicKey, payload.ownerSigningPublicKey),
  };
}

function payloadKey(secret: Uint8Array): Uint8Array {
  assertBytes(secret, CONNECT_SECRET_BYTES, "connect secret");
  return sodium().crypto_kdf_derive_from_key(32, 1, "ktconnct", secret);
}

function associatedData(cliPublicKey: Uint8Array): Uint8Array {
  assertBytes(cliPublicKey, KEY_PAIR_SEED_BYTES, "CLI public key");
  return concatBytes(utf8Encode("knowtarium-connect-v1\n"), cliPublicKey);
}

function parsePayload(plaintext: Uint8Array): ConnectPayload {
  const malformed = new CryptoError("malformed_envelope", "the connect payload is malformed");
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(plaintext));
  } catch {
    throw malformed;
  }
  const { token, ownerSigningPublicKey, wrapped, signed, signedGeneration } = (value ??
    {}) as Record<string, unknown>;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof ownerSigningPublicKey !== "string" ||
    typeof wrapped !== "string" ||
    typeof signed !== "object" ||
    signed === null ||
    typeof signedGeneration !== "object" ||
    signedGeneration === null
  ) {
    throw malformed;
  }
  try {
    return {
      token,
      ownerSigningPublicKey: fromBase64Url(ownerSigningPublicKey),
      signedWrappedKey: {
        wrapped: fromBase64Url(wrapped),
        signed: signed as SignedEnvelope,
        signedGeneration: signedGeneration as SignedEnvelope,
      },
    };
  } catch {
    throw malformed;
  }
}
