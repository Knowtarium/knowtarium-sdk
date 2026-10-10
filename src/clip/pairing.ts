import {
  concatBytes,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding.js";
import { ClipError } from "./errors.js";
import {
  extensionKeyValid,
  inboxKeyValid,
  type SignedExtensionKey,
  type SignedInboxKey,
} from "./keys.js";
import type { ClipSodium } from "./lib.js";
import { normalizeCategory } from "./payload.js";

// Pairing an extension. pair.html makes an Ed25519 key pair and a one-time 32-byte secret, starts a
// connect request (`client: "extension"`), shows the confirmation code at once and opens
// `<app>/connect/extension?request=<id>#signPublicKey=<base64url>&secret=<base64url>`; the fragment
// never reaches a server. After the person matched the code and allowed, the web app relays
//
//   0x01 || nonce (24) || XChaCha20-Poly1305(JSON)
//   key: crypto_kdf_derive_from_key(32, 1, "ktextpar", secret)
//   associated data: "knowtarium-extension-pairing-v1\n" || the extension's signing public key
//
// through the server, which can neither read nor forge it. The JSON holds the token, the IDs, the
// workspace name, the owner's signing public key (which the extension pins), the owner-signed
// extension_key and inbox_key, and the inbox folder's category names.

/** Format version of a sealed pairing payload, and its JSON's `v`. */
export const EXTENSION_PAIRING_VERSION = 1;
/** Bytes of the one-time pairing secret. */
export const PAIRING_SECRET_BYTES = 32;
/** The most category names a pairing carries. */
export const PAIRING_MAX_CATEGORIES = 200;

const NONCE_BYTES = 24;
const KDF_CONTEXT = "ktextpar";
const AD_PREFIX = "knowtarium-extension-pairing-v1\n";
const ID_BODY = "[0-7][0-9a-hjkmnp-tv-z]{25}";
const TOKEN = /^kte_[A-Za-z0-9_-]{32,128}$/;

/** What the web app seals for the extension once the person allowed it. */
export interface ExtensionPairing {
  /** The extension's token (`kte_...`), sent as `Authorization: Bearer`. */
  readonly token: string;
  readonly extensionId: string;
  /** The workspace owner's account. */
  readonly accountId: string;
  readonly workspaceId: string;
  /** The decrypted workspace name, for the popup. */
  readonly workspaceName: string;
  /** The owner's Ed25519 public key; the extension pins it. */
  readonly ownerSigningPublicKey: Uint8Array;
  /** The owner's `extension_key` over the extension's ID and its signing key. */
  readonly extensionKey: SignedExtensionKey;
  /** The latest owner-signed `inbox_key`. */
  readonly inboxKey: SignedInboxKey;
  /** The decrypted names of the inbox folder's direct subfolders (at most 200). */
  readonly categories: readonly string[];
}

/** The fragment of the pairing page: `signPublicKey=<base64url>&secret=<base64url>`. */
export function formatExtensionConnectFragment(link: {
  readonly signPublicKey: Uint8Array;
  readonly secret: Uint8Array;
}): string {
  if (link.signPublicKey.length !== 32 || link.secret.length !== PAIRING_SECRET_BYTES) {
    throw new ClipError("invalid", "the key and the secret are 32 bytes each");
  }
  return `signPublicKey=${toBase64Url(link.signPublicKey)}&secret=${toBase64Url(link.secret)}`;
}

function pairingKey(lib: ClipSodium, secret: Uint8Array): Uint8Array {
  if (!(secret instanceof Uint8Array) || secret.length !== PAIRING_SECRET_BYTES) {
    throw new ClipError("invalid", "the pairing secret is 32 bytes");
  }
  return lib.crypto_kdf_derive_from_key(32, 1, KDF_CONTEXT, secret);
}

function associatedData(signPublicKey: Uint8Array): Uint8Array {
  if (!(signPublicKey instanceof Uint8Array) || signPublicKey.length !== 32) {
    throw new ClipError("invalid", "the extension's public key is 32 bytes");
  }
  return concatBytes(utf8Encode(AD_PREFIX), signPublicKey);
}

/** The pairing payload's JSON text (web app side). */
function pairingJson(pairing: ExtensionPairing): string {
  const { envelope: inbox, signature: inboxSignature } = pairing.inboxKey;
  return JSON.stringify({
    v: EXTENSION_PAIRING_VERSION,
    token: pairing.token,
    extensionId: pairing.extensionId,
    accountId: pairing.accountId,
    workspaceId: pairing.workspaceId,
    workspaceName: pairing.workspaceName,
    ownerSigningPublicKey: toBase64Url(pairing.ownerSigningPublicKey),
    extensionKey: {
      createdAt: pairing.extensionKey.envelope.createdAt,
      signature: pairing.extensionKey.signature,
    },
    inboxKey: {
      revision: inbox.revision,
      generation: inbox.generation,
      publicKey: inbox.publicKey,
      folderId: inbox.folderId,
      createdAt: inbox.createdAt,
      signature: inboxSignature,
    },
    categories: pairing.categories.slice(0, PAIRING_MAX_CATEGORIES),
  });
}

/**
 * Seals a pairing payload for the extension (web app side) with the secret and the signing key
 * from the pairing link's fragment. `nonce` is for the test vectors only.
 */
export function sealExtensionPairingWith(
  lib: ClipSodium,
  pairing: ExtensionPairing,
  link: { readonly secret: Uint8Array; readonly signPublicKey: Uint8Array },
  nonce: Uint8Array = lib.randombytes_buf(NONCE_BYTES),
): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new ClipError("invalid", "the nonce is 24 bytes");
  const key = pairingKey(lib, link.secret);
  try {
    const ciphertext = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
      utf8Encode(pairingJson(pairing)),
      associatedData(link.signPublicKey),
      null,
      nonce,
      key,
    );
    return concatBytes(Uint8Array.of(EXTENSION_PAIRING_VERSION), nonce, ciphertext);
  } finally {
    lib.memzero(key);
  }
}

const badPayload = () => new ClipError("bad_payload", "the pairing payload is malformed");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = record[key];
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) {
    throw badPayload();
  }
  return value;
}

function integerField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw badPayload();
  return value;
}

/** Category names as folder names, cleaned like the extension's own, deduplicated, at most 200. */
function readCategories(value: unknown): string[] {
  if (!Array.isArray(value)) throw badPayload();
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of value.slice(0, PAIRING_MAX_CATEGORIES)) {
    if (typeof entry !== "string") throw badPayload();
    const name = normalizeCategory(entry);
    const folded = name.toUpperCase().toLowerCase();
    if (name === "" || seen.has(folded)) continue;
    seen.add(folded);
    names.push(name);
  }
  return names;
}

function readPairing(json: string): ExtensionPairing {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw badPayload();
  }
  if (!isRecord(value) || value["v"] !== EXTENSION_PAIRING_VERSION) throw badPayload();
  const accountId = stringField(value, "accountId", new RegExp(`^acc_${ID_BODY}$`));
  const workspaceId = stringField(value, "workspaceId", new RegExp(`^ws_${ID_BODY}$`));
  const extensionId = stringField(value, "extensionId", new RegExp(`^ext_${ID_BODY}$`));
  const extensionKey = value["extensionKey"];
  const inboxKey = value["inboxKey"];
  if (!isRecord(extensionKey) || !isRecord(inboxKey)) throw badPayload();
  let ownerSigningPublicKey: Uint8Array;
  try {
    ownerSigningPublicKey = fromBase64Url(stringField(value, "ownerSigningPublicKey"));
  } catch {
    throw badPayload();
  }
  if (ownerSigningPublicKey.length !== 32) throw badPayload();
  return {
    token: stringField(value, "token", TOKEN),
    extensionId,
    accountId,
    workspaceId,
    workspaceName: stringField(value, "workspaceName"),
    ownerSigningPublicKey,
    extensionKey: {
      envelope: {
        type: "extension_key",
        accountId,
        workspaceId,
        createdAt: stringField(extensionKey, "createdAt"),
        extensionId,
        // filled in from the extension's own key by `openExtensionPairingWith`
        signPublicKey: "",
      },
      signature: stringField(extensionKey, "signature"),
    },
    inboxKey: {
      envelope: {
        type: "inbox_key",
        accountId,
        workspaceId,
        createdAt: stringField(inboxKey, "createdAt"),
        revision: integerField(inboxKey, "revision"),
        generation: integerField(inboxKey, "generation"),
        publicKey: stringField(inboxKey, "publicKey"),
        folderId: stringField(inboxKey, "folderId"),
      },
      signature: stringField(inboxKey, "signature"),
    },
    categories: readCategories(value["categories"]),
  };
}

/**
 * Opens the pairing payload with the one-time secret and the extension's own signing key, then
 * checks it: the `extension_key` rebuilt from the payload's extension ID and the extension's OWN
 * public key must verify under the payload's owner key (`wrong_key` otherwise), and the
 * `inbox_key` must verify under it for that account and workspace (`bad_signature`). Throws
 * `bad_payload` when the secret doesn't open it or its shape is wrong. The only thing
 * `knowtarium/clip` decrypts.
 */
export function openExtensionPairingWith(
  lib: ClipSodium,
  sealed: Uint8Array,
  link: { readonly secret: Uint8Array; readonly signPublicKey: Uint8Array },
): ExtensionPairing {
  if (!(sealed instanceof Uint8Array) || sealed.length < 1 + NONCE_BYTES + 16) throw badPayload();
  if (sealed[0] !== EXTENSION_PAIRING_VERSION) throw badPayload();
  const key = pairingKey(lib, link.secret);
  let plaintext: Uint8Array;
  try {
    plaintext = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sealed.subarray(1 + NONCE_BYTES),
      associatedData(link.signPublicKey),
      sealed.subarray(1, 1 + NONCE_BYTES),
      key,
    );
  } catch (error) {
    if (error instanceof ClipError) throw error;
    throw badPayload();
  } finally {
    lib.memzero(key);
  }
  let json: string;
  try {
    json = utf8Decode(plaintext);
  } catch {
    throw badPayload();
  } finally {
    lib.memzero(plaintext);
  }
  const read = readPairing(json);
  const pairing: ExtensionPairing = {
    ...read,
    extensionKey: {
      ...read.extensionKey,
      envelope: { ...read.extensionKey.envelope, signPublicKey: toBase64Url(link.signPublicKey) },
    },
  };
  const owner = {
    ownerSigningPublicKey: pairing.ownerSigningPublicKey,
    accountId: pairing.accountId,
    workspaceId: pairing.workspaceId,
  };
  if (
    !extensionKeyValid(lib, pairing.extensionKey, {
      ...owner,
      extensionId: pairing.extensionId,
      signPublicKey: link.signPublicKey,
    })
  ) {
    throw new ClipError("wrong_key", "the owner didn't vouch for this extension's key");
  }
  if (!inboxKeyValid(lib, pairing.inboxKey, { ...owner, minRevision: 1, minGeneration: 1 })) {
    throw new ClipError("bad_signature", "the inbox key isn't signed by the workspace owner");
  }
  return pairing;
}
