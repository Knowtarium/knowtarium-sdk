import { z } from "zod";

import { AuthHash, EncKey, PublicKey } from "./ciphertext.js";
import { AccountId } from "./ids.js";
import { PlanId } from "./plans.js";
import { Base64Url, base64UrlLength, Email, Ok, Timestamp } from "./primitives.js";
import { defineRoute } from "./route.js";

/*
 * The account's key material. The password is split in the browser: Argon2id gives the master key
 * (never sent) and the login hash, which is the "password" Better Auth receives (see auth.ts).
 * The master key wraps the account's two secret keys; the recovery key wraps them again.
 */

/** An Argon2id salt (16 bytes). */
export const Salt = Base64Url.length(base64UrlLength(16));

/**
 * Argon2id work factors for new accounts (RFC 9106's second recommended option), the same values
 * as `knowtarium/crypto`'s `DEFAULT_KDF_OPS_LIMIT` and `DEFAULT_KDF_MEM_LIMIT`, which the client
 * treats as the floor. The sync API uses them for the fake prelogin answer to an unknown email, so
 * it looks like a real account's. A test outside both modules keeps the two in step.
 */
export const DEFAULT_KDF_OPS_LIMIT = 3;
/** Argon2id memory for new accounts, in bytes (64 MiB). See `DEFAULT_KDF_OPS_LIMIT`. */
export const DEFAULT_KDF_MEM_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Argon2id parameters (libsodium `crypto_pwhash`, `ALG_ARGON2ID13`), stored per account so the
 * browser can derive the master key again on sign-in.
 */
export const KdfParams = z.strictObject({
  algorithm: z.literal("argon2id13"),
  salt: Salt,
  opsLimit: z.int().min(1).max(64),
  memLimitBytes: z
    .int()
    .min(8192)
    .max(4 * 1024 * 1024 * 1024),
});
export type KdfParams = z.infer<typeof KdfParams>;

/**
 * The account's public keys: X25519 (`box`, receives wrapped keys) and Ed25519 (`sign`, which the
 * server uses to verify the person's signed envelopes).
 */
export const AccountPublicKeys = z.strictObject({ box: PublicKey, sign: PublicKey });
export type AccountPublicKeys = z.infer<typeof AccountPublicKeys>;

/**
 * The account's two secret keys (the X25519 private key and the Ed25519 seed), wrapped together
 * as one blob (by the master key or by the recovery key), exactly as `wrapAccountKeys` in
 * `knowtarium/crypto` returns them.
 */
export const WrappedSecretKeys = z.strictObject({ encSecretKeys: EncKey });
export type WrappedSecretKeys = z.infer<typeof WrappedSecretKeys>;

/** The key material a signed-in browser needs to unlock. */
export const AccountKeys = z.object({
  kdf: KdfParams,
  publicKeys: AccountPublicKeys,
  wrappedByMaster: WrappedSecretKeys,
});
export type AccountKeys = z.infer<typeof AccountKeys>;

/** The profile the server keeps (Better Auth's user row plus the plan). */
export const Account = z.object({
  id: AccountId,
  email: Email,
  emailVerified: z.boolean(),
  planId: PlanId,
  createdAt: Timestamp,
});
export type Account = z.infer<typeof Account>;

export const GetAccountResponse = z.object({ account: Account, keys: AccountKeys });
export type GetAccountResponse = z.infer<typeof GetAccountResponse>;

/**
 * Changes the password: the new login hash, KDF parameters and re-wrapped secret keys replace the
 * old ones in one transaction, and other sessions are signed out. Better Auth's own
 * `/change-password` is disabled, since it would swap the login hash without the keys.
 */
export const ChangePasswordRequest = z.strictObject({
  currentLoginHash: AuthHash,
  loginHash: AuthHash,
  kdf: KdfParams,
  wrappedByMaster: WrappedSecretKeys,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/**
 * Replaces the recovery key while signed in, without the old one (it was lost, or the person
 * wants a new code): proof of the current password (its login hash, checked like
 * `changePassword`), the account's secret keys wrapped by the new recovery key, and the new
 * recovery auth hash (the server stores only its SHA-256). The old recovery key stops working at
 * once; the password and the sessions are unchanged.
 */
export const ReplaceRecoveryKeyRequest = z.strictObject({
  currentLoginHash: AuthHash,
  wrappedByRecovery: WrappedSecretKeys,
  recoveryAuthHash: AuthHash,
});
export type ReplaceRecoveryKeyRequest = z.infer<typeof ReplaceRecoveryKeyRequest>;

/*
 * Sessions are listed with Better Auth's `/list-sessions`, whose response carries session ids but
 * never session tokens (the sync API strips them). `revokeSession` signs one out by that id, only
 * when it belongs to the signed-in account; Better Auth's `/revoke-session`, which takes the token,
 * is disabled.
 */
export const accountRoutes = {
  getAccount: defineRoute({
    method: "GET",
    path: "/account",
    auth: "session",
    summary: "The signed-in account's profile and wrapped keys",
    response: GetAccountResponse,
  }),
  changePassword: defineRoute({
    method: "PUT",
    path: "/account/password",
    auth: "session",
    summary: "Swap the login hash and the wrapped keys at once; signs out other sessions",
    body: ChangePasswordRequest,
    response: Ok,
  }),
  replaceRecoveryKey: defineRoute({
    method: "PUT",
    path: "/account/recovery-key",
    auth: "session",
    summary: "Replace the recovery key, proving the current password; the old key stops working",
    body: ReplaceRecoveryKeyRequest,
    response: Ok,
  }),
  revokeSession: defineRoute({
    method: "DELETE",
    path: "/account/sessions/:sessionId",
    auth: "session",
    summary: "Sign out one of the account's own sessions by its id",
    response: Ok,
  }),
};
