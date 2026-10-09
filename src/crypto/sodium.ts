import libsodium from "libsodium-wrappers-sumo";

import { CryptoError } from "./errors.js";

/** The libsodium API, as the rest of `src/crypto` sees it. */
export type Sodium = typeof libsodium;

let loaded = false;

/**
 * Loads libsodium (the sumo build, which has Argon2id). Await it once before calling anything else
 * in `knowtarium/crypto`; later calls resolve immediately.
 */
export async function ready(): Promise<void> {
  await libsodium.ready;
  loaded = true;
}

/** libsodium, or a `not_ready` error when `ready()` has not finished yet. */
export function sodium(): Sodium {
  if (!loaded) throw new CryptoError("not_ready", "await ready() before using knowtarium/crypto");
  return libsodium;
}

/**
 * Overwrites `bytes` with zeros. Use it on keys and plaintext you no longer need. JavaScript can
 * still hold copies the SDK can't reach (strings, engine buffers), so this narrows exposure rather
 * than guaranteeing erasure.
 */
export function wipe(...buffers: Uint8Array[]): void {
  for (const bytes of buffers) {
    if (loaded) libsodium.memzero(bytes);
    else bytes.fill(0);
  }
}
