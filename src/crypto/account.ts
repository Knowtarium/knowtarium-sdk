import { createKdfParams, derivePasswordSecrets, deriveRecoverySecrets } from "./kdf.js";
import type { PasswordKdfParams } from "./kdf.js";
import {
  type AccountKeys,
  type AccountPublicKeys,
  accountPublicKeys,
  createAccountKeys,
} from "./keys.js";
import { formatRecoveryCode, generateRecoveryKey } from "./recovery-code.js";
import { wipe } from "./sodium.js";
import { wrapAccountKeys } from "./wrap.js";

// The account flows, composed from the pieces. Sign-in and recovery need a server round trip
// between their steps, so they are left to the caller (see DEVELOPING.md):
//
//   sign in:  derivePasswordSecrets(password, params) -> send authHash -> receive wrappedByPassword
//             -> unwrapAccountKeys(wrappedByPassword, keyEncryptionKey, "password", publicKeys)
//   recover:  parseRecoveryCode(code) -> deriveRecoverySecrets(key) -> send authHash
//             -> receive wrappedByRecovery -> unwrapAccountKeys(..., "recovery", publicKeys)
//             -> changePassword(keys, newPassword)

/** What the password gives the server: the KDF params, the login hash and one wrapped key copy. */
export interface PasswordMaterial {
  /** Stored per account and served before sign-in. */
  readonly kdfParams: PasswordKdfParams;
  /** Sent to the server, which should hash it again before storing it. */
  readonly loginHash: Uint8Array;
  /** The account's private keys wrapped by the password's key-encryption key. */
  readonly wrappedByPassword: Uint8Array;
}

/** What a recovery key gives the server, plus the code to show the user once. */
export interface RecoveryMaterial {
  /** Show once, ask the user to save it, then drop it. Never store or send it. */
  readonly recoveryCode: string;
  /** Sent to the server, which should hash it again before storing it. */
  readonly recoveryAuthHash: Uint8Array;
  /** The account's private keys wrapped by the recovery key's key-encryption key. */
  readonly wrappedByRecovery: Uint8Array;
}

/** A new account: its keys (kept in memory) and everything sign-up sends or shows. */
export interface NewAccount extends PasswordMaterial, RecoveryMaterial {
  readonly keys: AccountKeys;
  readonly publicKeys: AccountPublicKeys;
}

/** Creates an account's keys, password material and recovery code. Runs Argon2id: use a Web Worker. */
export function createAccount(password: string): NewAccount {
  const keys = createAccountKeys();
  return {
    keys,
    publicKeys: accountPublicKeys(keys),
    ...changePassword(keys, password),
    ...createRecovery(keys),
  };
}

/**
 * New password material for unlocked account keys: a fresh salt, the current default Argon2id
 * params and a new wrapped copy. Used for password changes, after recovery, and to raise the work
 * factor of an old account. No content is re-encrypted.
 */
export function changePassword(keys: AccountKeys, newPassword: string): PasswordMaterial {
  const kdfParams = createKdfParams();
  const { authHash, keyEncryptionKey } = derivePasswordSecrets(newPassword, kdfParams);
  try {
    return {
      kdfParams,
      loginHash: authHash,
      wrappedByPassword: wrapAccountKeys(keys, keyEncryptionKey, "password"),
    };
  } finally {
    wipe(keyEncryptionKey);
  }
}

/** A new recovery key for unlocked account keys (at sign-up, or to replace a lost code). */
export function createRecovery(keys: AccountKeys): RecoveryMaterial {
  const recoveryKey = generateRecoveryKey();
  const { authHash, keyEncryptionKey } = deriveRecoverySecrets(recoveryKey);
  try {
    return {
      recoveryCode: formatRecoveryCode(recoveryKey),
      recoveryAuthHash: authHash,
      wrappedByRecovery: wrapAccountKeys(keys, keyEncryptionKey, "recovery"),
    };
  } finally {
    wipe(recoveryKey, keyEncryptionKey);
  }
}
