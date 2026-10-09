import { toBase64Url } from "../../crypto/index.js";
import { formatId, ID_RANDOM_BYTES, type IdPrefix } from "../../protocol/index.js";
import { sodium } from "../../crypto/sodium.js";

/**
 * A new client-made ID (`note_...`, `cmt_...` and so on) from 16 random bytes. Needs
 * `await ready()` from `knowtarium/crypto` first, like everything that encrypts.
 */
export function newId<const P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return formatId(prefix, sodium().randombytes_buf(ID_RANDOM_BYTES));
}

/** A new random nonce for a pending change (16 bytes, base64url). Needs `await ready()`. */
export function newPendingNonce(): string {
  return toBase64Url(sodium().randombytes_buf(16));
}
