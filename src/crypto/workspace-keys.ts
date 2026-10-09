import { CryptoError } from "./errors.js";
import { sodium } from "./sodium.js";
import { assertBytes } from "./validate.js";

// A workspace key encrypts everything in one workspace. Rotating it (when a recipient is revoked)
// creates the next generation for new writes; blobs keep the generation they were written with,
// so old generations stay decryptable and re-encryption can happen lazily.

/** Bytes in a workspace key (an XChaCha20-Poly1305 key). */
export const WORKSPACE_KEY_BYTES = 32;

/** The first generation of a new workspace. */
export const FIRST_KEY_GENERATION = 1;

/** One generation of a workspace key. */
export interface WorkspaceKey {
  /** 1 for a new workspace, then +1 per rotation; at most 2^32 - 1. */
  readonly generation: number;
  /** 32 random bytes. */
  readonly key: Uint8Array;
}

/** Every generation of one workspace's key the client holds, for reading old and new blobs. */
export interface WorkspaceKeyring {
  /** The newest generation: new blobs are written with it. */
  readonly current: WorkspaceKey;
  /** The key of one generation, if the keyring has it. */
  get(generation: number): WorkspaceKey | undefined;
}

/** A new random workspace key, generation 1. */
export function createWorkspaceKey(): WorkspaceKey {
  return {
    generation: FIRST_KEY_GENERATION,
    key: sodium().crypto_aead_xchacha20poly1305_ietf_keygen(),
  };
}

/** The next generation after `current`: a new random key, generation + 1. */
export function rotateWorkspaceKey(current: WorkspaceKey): WorkspaceKey {
  assertGeneration(current.generation);
  if (current.generation === 0xffffffff) {
    throw new CryptoError("invalid_input", "no key generation after 4294967295");
  }
  return {
    generation: current.generation + 1,
    key: sodium().crypto_aead_xchacha20poly1305_ietf_keygen(),
  };
}

/** A keyring over `keys`; the highest generation is `current`. Duplicate generations are refused. */
export function createKeyring(keys: Iterable<WorkspaceKey>): WorkspaceKeyring {
  const byGeneration = new Map<number, WorkspaceKey>();
  for (const key of keys) {
    assertWorkspaceKey(key);
    if (byGeneration.has(key.generation)) {
      throw new CryptoError("invalid_input", "the keyring has two keys for one generation");
    }
    byGeneration.set(key.generation, key);
  }
  const newest = Math.max(...byGeneration.keys());
  const current = byGeneration.get(newest);
  if (current === undefined) throw new CryptoError("invalid_input", "the keyring is empty");
  return { current, get: (generation) => byGeneration.get(generation) };
}

/** Throws `invalid_input` unless `key` is a well-formed workspace key. */
export function assertWorkspaceKey(key: WorkspaceKey): void {
  assertGeneration(key.generation);
  assertBytes(key.key, WORKSPACE_KEY_BYTES, "workspace key");
}

function assertGeneration(generation: number): void {
  if (
    !Number.isInteger(generation) ||
    generation < FIRST_KEY_GENERATION ||
    generation > 0xffffffff
  ) {
    throw new CryptoError("invalid_input", "a key generation is an integer from 1 to 2^32 - 1");
  }
}
