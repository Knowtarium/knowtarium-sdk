import { extensionConfirmationCodeWith } from "../clip/keys.js";
import { type ExtensionPairing, sealExtensionPairingWith } from "../clip/pairing.js";
import type { BoxKeyPair } from "./keys.js";
import { sodium, wipe } from "./sodium.js";
import { assertWorkspaceKey, type WorkspaceKey } from "./workspace-keys.js";

// The web clipper's keys on the side that holds the workspace key (the web app and the CLI).
//
//   workspace key N --crypto_kdf "ktinbox_", subkey id 1--> inbox seed N
//                   --crypto_box_seed_keypair--> inbox key pair N (never stored or wrapped)
//
// Whoever holds generation N derives inbox key N, and nobody else can: a rotation gives a new
// inbox key pair with no extra step, so a revoked agent that kept generation N can't open clips
// sealed to N+1. The owner signs the public half in `inbox_key` (knowtarium/client
// `ensureInboxKey`); the extension seals clips to it (knowtarium/clip), and filers open them
// (knowtarium/client `openClip`).

/** One generation's inbox key pair. */
export interface InboxKeyPair extends BoxKeyPair {
  /** The workspace key generation it comes from. */
  readonly generation: number;
}

/** The inbox key pair of a workspace key generation. Wipe `privateKey` when done with it. */
export function deriveInboxKeyPair(key: WorkspaceKey): InboxKeyPair {
  assertWorkspaceKey(key);
  const lib = sodium();
  const seed = lib.crypto_kdf_derive_from_key(32, 1, "ktinbox_", key.key);
  try {
    const { publicKey, privateKey } = lib.crypto_box_seed_keypair(seed);
    return { generation: key.generation, publicKey, privateKey };
  } finally {
    wipe(seed);
  }
}

/**
 * The pairing code (`ABCD-EFGH`) over an extension's signing public key and the connect request's
 * ID, as the web app shows it before Allow (the extension shows the same with knowtarium/clip).
 */
export function extensionConfirmationCode(signPublicKey: Uint8Array, requestId: string): string {
  return extensionConfirmationCodeWith(sodium(), signPublicKey, requestId);
}

/**
 * Seals the pairing payload for an extension (web app side), with the one-time secret and the
 * extension's signing public key from the pairing link's fragment; relay it with `relayConnect`.
 * The extension opens it with `openExtensionPairing` from knowtarium/clip.
 */
export function sealExtensionPairing(
  pairing: ExtensionPairing,
  link: { readonly secret: Uint8Array; readonly signPublicKey: Uint8Array },
): Uint8Array {
  return sealExtensionPairingWith(sodium(), pairing, link);
}
