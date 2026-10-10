import libsodium from "libsodium-wrappers";

import { ClipError } from "./errors.js";
import type { ClipSodium } from "./lib.js";

// knowtarium/clip loads the standard libsodium build, not the sumo one the rest of the package
// uses: it has every function the extension needs (no Argon2id), at about half the size.

let loaded = false;

/**
 * Loads libsodium (the standard build). Await it once before calling anything else in
 * `knowtarium/clip`; later calls resolve immediately.
 */
export async function ready(): Promise<void> {
  await libsodium.ready;
  loaded = true;
}

/** libsodium, or a `not_ready` error when `ready()` has not finished yet. */
export function sodium(): ClipSodium {
  if (!loaded) throw new ClipError("not_ready", "await ready() before using knowtarium/clip");
  return libsodium;
}
