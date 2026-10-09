import { fromBase64Url, toBase64Url, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { sodium, wipe } from "./sodium.js";
import { assertBytes } from "./validate.js";

// Password and recovery key derivation.
//
//   password --Argon2id(params)--> master key --KDF "ktlogin_"--> login hash (sent to the server)
//                                             \--KDF "ktpwdkek"--> key-encryption key (stays local)
//   recovery key -----------------------------KDF "ktrecaut"--> recovery auth hash (sent to the server)
//                                             \--KDF "ktreckek"--> key-encryption key (stays local)
//
// The KDF is libsodium's crypto_kdf (BLAKE2b keyed with the root secret, 8-byte context, subkey id
// 1). Each output has its own context, so the login hash reveals nothing about the key-encryption
// key: the server gets a value it can check but never one that decrypts.

/** The Argon2id version libsodium implements (Argon2 v1.3, `crypto_pwhash_ALG_ARGON2ID13`). */
export const ARGON2ID_ALGORITHM = "argon2id13";

/** Bytes of Argon2id salt, one random salt per account. */
export const KDF_SALT_BYTES = 16;

/**
 * Argon2id parameters for new accounts: 3 passes over 64 MiB (libsodium always uses one lane).
 * This is RFC 9106's second recommended option (the one for memory-constrained environments), and
 * it is the floor: parameters from the server below it are refused, so a malicious server can't
 * downgrade the work factor to make the login hash cheaper to brute-force. On a laptop it takes
 * 0.1 to 0.3 s (Chromium, WebKit, Node), so an older phone should stay near a second; libsodium's
 * MODERATE preset (256 MiB) takes about five times longer and risks running out of memory in
 * low-end mobile browsers.
 */
export const DEFAULT_KDF_OPS_LIMIT = 3;
/** Argon2id memory for new accounts, in bytes (64 MiB). See `DEFAULT_KDF_OPS_LIMIT`. */
export const DEFAULT_KDF_MEM_LIMIT = 64 * 1024 * 1024;

/** The most work a stored parameter set may ask for, so a hostile server can't hang the client. */
const MAX_KDF_OPS_LIMIT = 20;
const MAX_KDF_MEM_LIMIT = 1024 * 1024 * 1024;

/**
 * How an account's password becomes its master key. Stored per account (next to the login hash)
 * and served before sign-in, so the work factor can be raised later: sign in with the old params,
 * then re-derive with `createKdfParams()` and re-wrap. Plain JSON, safe to store and send.
 */
export interface PasswordKdfParams {
  /** Always `"argon2id13"` for now. */
  readonly algorithm: typeof ARGON2ID_ALGORITHM;
  /** Argon2id passes (libsodium `opslimit`). */
  readonly opsLimit: number;
  /** Argon2id memory in bytes (libsodium `memlimit`). */
  readonly memLimit: number;
  /** The account's random 16-byte salt, base64url. */
  readonly salt: string;
}

/** What a password or recovery key yields: one value for the server, one that stays on the device. */
export interface DerivedSecrets {
  /** Proves knowledge of the secret to the server. The server should hash it again before storing. */
  readonly authHash: Uint8Array;
  /** Wraps and unwraps the account's private keys. Never leaves the device. */
  readonly keyEncryptionKey: Uint8Array;
}

/** Parameters for a new account (or a password change): the defaults and a fresh random salt. */
export function createKdfParams(): PasswordKdfParams {
  return {
    algorithm: ARGON2ID_ALGORITHM,
    opsLimit: DEFAULT_KDF_OPS_LIMIT,
    memLimit: DEFAULT_KDF_MEM_LIMIT,
    salt: toBase64Url(sodium().randombytes_buf(KDF_SALT_BYTES)),
  };
}

/**
 * Throws `invalid_kdf_params` unless `params` is a parameter set this SDK accepts: Argon2id13, a
 * 16-byte salt, and a work factor between the defaults (the floor) and a ceiling of 20 passes over
 * 1 GiB. Use it on params from the server before anything else.
 */
export function assertKdfParams(params: unknown): asserts params is PasswordKdfParams {
  const { algorithm, opsLimit, memLimit, salt } = (params ?? {}) as Record<string, unknown>;
  const inRange = (value: unknown, min: number, max: number) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
  if (
    algorithm !== ARGON2ID_ALGORITHM ||
    !inRange(opsLimit, DEFAULT_KDF_OPS_LIMIT, MAX_KDF_OPS_LIMIT) ||
    !inRange(memLimit, DEFAULT_KDF_MEM_LIMIT, MAX_KDF_MEM_LIMIT) ||
    typeof salt !== "string" ||
    decodedLength(salt) !== KDF_SALT_BYTES
  ) {
    throw new CryptoError("invalid_kdf_params", "unsupported password KDF parameters");
  }
}

/**
 * Derives the login hash and key-encryption key from a password. The password is NFKC-normalized
 * first, so the same password typed on different keyboards gives the same keys.
 *
 * Argon2id is deliberately slow (0.1 to 0.3 s on a laptop, longer on a phone) and blocks the
 * thread it runs on: in a browser, call it from a Web Worker.
 */
export function derivePasswordSecrets(password: string, params: PasswordKdfParams): DerivedSecrets {
  assertKdfParams(params);
  if (password.length === 0) throw new CryptoError("invalid_input", "the password is empty");
  const lib = sodium();
  const passwordBytes = utf8Encode(password.normalize("NFKC"));
  const masterKey = lib.crypto_pwhash(
    32,
    passwordBytes,
    fromBase64Url(params.salt),
    params.opsLimit,
    params.memLimit,
    lib.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return {
      authHash: deriveSubkey(masterKey, "ktlogin_"),
      keyEncryptionKey: deriveSubkey(masterKey, "ktpwdkek"),
    };
  } finally {
    wipe(masterKey, passwordBytes);
  }
}

/** Derives the recovery auth hash and key-encryption key from a 32-byte recovery key. */
export function deriveRecoverySecrets(recoveryKey: Uint8Array): DerivedSecrets {
  assertBytes(recoveryKey, 32, "recovery key");
  return {
    authHash: deriveSubkey(recoveryKey, "ktrecaut"),
    keyEncryptionKey: deriveSubkey(recoveryKey, "ktreckek"),
  };
}

function decodedLength(base64Url: string): number | undefined {
  try {
    return fromBase64Url(base64Url).length;
  } catch {
    return undefined;
  }
}

/** A 32-byte subkey of `root` for one 8-character context (libsodium crypto_kdf, subkey id 1). */
function deriveSubkey(root: Uint8Array, context: string): Uint8Array {
  return sodium().crypto_kdf_derive_from_key(32, 1, context, root);
}
