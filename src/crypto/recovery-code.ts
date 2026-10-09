import { fromBase32, toBase32, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { sodium } from "./sodium.js";
import { assertBytes } from "./validate.js";

// The recovery key is 32 random bytes the user saves at sign-up. It is shown as a recovery code:
// the key and a 3-byte checksum (35 bytes, 280 bits) in Crockford base32, 56 characters in 14
// groups of 4, like "7K3M-QX9A-...". The checksum is the first 3 bytes of BLAKE2b-256 of the key,
// keyed with "knowtarium recovery code v1", so a typo is caught before any network call (a wrong
// code passes by chance with odds of 1 in 16.7 million).

/** Bytes of recovery key (256 bits). */
export const RECOVERY_KEY_BYTES = 32;

const CHECKSUM_BYTES = 3;
const CHECKSUM_KEY = "knowtarium recovery code v1";
const GROUP_LENGTH = 4;

/** A new random recovery key. Show it once with `formatRecoveryCode`, never store or send it. */
export function generateRecoveryKey(): Uint8Array {
  return sodium().randombytes_buf(RECOVERY_KEY_BYTES);
}

/** The recovery code for a recovery key: 14 dash-separated groups of 4 Crockford base32 characters. */
export function formatRecoveryCode(recoveryKey: Uint8Array): string {
  assertBytes(recoveryKey, RECOVERY_KEY_BYTES, "recovery key");
  const payload = new Uint8Array(RECOVERY_KEY_BYTES + CHECKSUM_BYTES);
  payload.set(recoveryKey);
  payload.set(checksum(recoveryKey), RECOVERY_KEY_BYTES);
  const text = toBase32(payload);
  payload.fill(0);
  return text.match(new RegExp(`.{1,${String(GROUP_LENGTH)}}`, "g"))?.join("-") ?? "";
}

/**
 * The recovery key in a recovery code as the user typed it: case, spaces and dashes don't matter,
 * and O reads as 0, I and L as 1. Throws `invalid_recovery_code` for anything else, including a
 * checksum that doesn't match.
 */
export function parseRecoveryCode(code: string): Uint8Array {
  const payload = fromBase32(code.replace(/[\s-]/g, ""), RECOVERY_KEY_BYTES + CHECKSUM_BYTES);
  const invalid = new CryptoError("invalid_recovery_code", "this is not a valid recovery code");
  if (payload === undefined) throw invalid;
  const recoveryKey = payload.slice(0, RECOVERY_KEY_BYTES);
  const valid = sodium().memcmp(checksum(recoveryKey), payload.subarray(RECOVERY_KEY_BYTES));
  payload.fill(0);
  if (!valid) {
    recoveryKey.fill(0);
    throw invalid;
  }
  return recoveryKey;
}

function checksum(recoveryKey: Uint8Array): Uint8Array {
  return sodium()
    .crypto_generichash(32, recoveryKey, utf8Encode(CHECKSUM_KEY))
    .slice(0, CHECKSUM_BYTES);
}
