import { z } from "zod";

import { Account, AccountPublicKeys, KdfParams, WrappedSecretKeys } from "./account.js";
import { AuthHash } from "./ciphertext.js";
import { Email, Ok, secretSchema, Timestamp } from "./primitives.js";
import { defineRoute } from "./route.js";

/*
 * Accounts and browser sessions are Better Auth, self-hosted in the sync API under
 * `BETTER_AUTH_BASE_PATH` (sign-up, sign-in, sign-out, session, email verification, session list
 * and revoke, delete-user); the web app calls those with the Better Auth client. The "password"
 * Better Auth receives is always the login hash (base64url), never the real password; the server
 * stores only a SHA-256 of it. Around Better Auth, this package defines:
 *
 * - `prelogin`: the account's KDF parameters, to derive the login hash before signing in;
 * - `SignUpKeyMaterial`: the keys sent with sign-up, as the Better Auth additional field
 *   `KEY_MATERIAL_FIELD` (a JSON string both sides validate with this schema);
 * - `changePassword` (account.ts): swaps the login hash and wrapped keys at once;
 * - `revokeSession` (account.ts): signs out one session by its id;
 * - recovery with the recovery key (`recoveryStart`, `recoveryComplete`).
 *
 * Better Auth's email password reset (`/forget-password`, `/reset-password`) and its
 * `/change-password` are disabled: they would change the login hash without re-wrapping the keys,
 * which loses the data. Better Auth's `/revoke-session` is disabled too, in favor of
 * `revokeSession`: it takes a session token, and no Better Auth response body ever carries one
 * (the token lives only in the httpOnly session cookie; the sync API strips `token` from session
 * objects, such as those `/get-session` and `/list-sessions` return). Sign-up sends `name: ""`, since a display name would be plaintext. Every
 * Better Auth POST carries `Knowtarium-Request: 1` like any other state-changing request.
 */

/** Where the sync API mounts Better Auth's handler. */
export const BETTER_AUTH_BASE_PATH = "/auth";

/** Better Auth endpoints the sync API must turn off. */
export const BETTER_AUTH_DISABLED_PATHS = [
  "/forget-password",
  "/reset-password",
  "/change-password",
  "/change-email",
  "/revoke-session",
] as const;

/** The Better Auth additional field on the user that carries `SignUpKeyMaterial` as JSON. */
export const KEY_MATERIAL_FIELD = "keyMaterial";

/** The keys a new account uploads with its Better Auth sign-up. None of it is readable by us. */
export const SignUpKeyMaterial = z.strictObject({
  kdf: KdfParams,
  publicKeys: AccountPublicKeys,
  wrappedByMaster: WrappedSecretKeys,
  wrappedByRecovery: WrappedSecretKeys,
  /** Derived from the recovery key; the server stores only its SHA-256. */
  recoveryAuthHash: AuthHash,
});
export type SignUpKeyMaterial = z.infer<typeof SignUpKeyMaterial>;

/** The value of the `keyMaterial` sign-up field. */
export function encodeKeyMaterial(material: SignUpKeyMaterial): string {
  return JSON.stringify(SignUpKeyMaterial.parse(material));
}

/** Reads the `keyMaterial` sign-up field; null when it is missing or invalid. */
export function parseKeyMaterial(value: unknown): SignUpKeyMaterial | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = SignUpKeyMaterial.safeParse(parsed);
  return result.success ? result.data : null;
}

/** A short-lived grant from `recoveryStart`, used once by `recoveryComplete`. */
export const RecoveryGrant = secretSchema("ktr");

/**
 * Step one of sign-in. For an unknown email the server answers with the same shape: stable fake
 * parameters derived from HMAC(server secret, email), so the answer never reveals whether an
 * account exists.
 */
export const PreloginRequest = z.strictObject({ email: Email });
export type PreloginRequest = z.infer<typeof PreloginRequest>;
export const PreloginResponse = z.object({ kdf: KdfParams });
export type PreloginResponse = z.infer<typeof PreloginResponse>;

/** Forgot password, with the recovery key: prove it is held, get the keys it wraps. */
export const RecoveryStartRequest = z.strictObject({ email: Email, recoveryAuthHash: AuthHash });
export type RecoveryStartRequest = z.infer<typeof RecoveryStartRequest>;
export const RecoveryStartResponse = z.object({
  recoveryGrant: RecoveryGrant,
  expiresAt: Timestamp,
  publicKeys: AccountPublicKeys,
  wrappedByRecovery: WrappedSecretKeys,
});
export type RecoveryStartResponse = z.infer<typeof RecoveryStartResponse>;

/**
 * A new password and a new recovery key, swapped in at once: the login hash (Better Auth's
 * credential), the KDF parameters and both wrappings. The old password and recovery key stop
 * working, every session is signed out, and a new session cookie is set.
 */
export const RecoveryCompleteRequest = z.strictObject({
  recoveryGrant: RecoveryGrant,
  loginHash: AuthHash,
  kdf: KdfParams,
  wrappedByMaster: WrappedSecretKeys,
  wrappedByRecovery: WrappedSecretKeys,
  recoveryAuthHash: AuthHash,
});
export type RecoveryCompleteRequest = z.infer<typeof RecoveryCompleteRequest>;

export const RecoveryCompleteResponse = z.object({ account: Account });
export type RecoveryCompleteResponse = z.infer<typeof RecoveryCompleteResponse>;

/**
 * Starting over without the password or the recovery key: the email gets a single-use link
 * holding this token (`kts_...`). Completing it replaces the account's keys with new ones, so
 * nothing encrypted under the old keys can be read again.
 */
export const AccountResetToken = secretSchema("kts");
export type AccountResetToken = z.infer<typeof AccountResetToken>;

/** Asks for a start-over link. The answer is the same whether or not the email has an account. */
export const AccountResetRequest = z.strictObject({ email: Email });
export type AccountResetRequest = z.infer<typeof AccountResetRequest>;

/**
 * A fresh account's key material, made like at sign-up, with the token from the link and the new
 * login hash. The old keys, sessions and recovery key stop working, and a session cookie is set.
 */
export const AccountResetCompleteRequest = SignUpKeyMaterial.extend({
  resetToken: AccountResetToken,
  loginHash: AuthHash,
});
export type AccountResetCompleteRequest = z.infer<typeof AccountResetCompleteRequest>;

export const authRoutes = {
  prelogin: defineRoute({
    method: "POST",
    path: "/prelogin",
    auth: "none",
    summary: "The account's KDF parameters (made-up but stable for unknown emails)",
    body: PreloginRequest,
    response: PreloginResponse,
  }),
  recoveryStart: defineRoute({
    method: "POST",
    path: "/recovery-grants",
    auth: "none",
    summary: "Prove the recovery key is held; returns the keys it wraps and a grant",
    body: RecoveryStartRequest,
    response: RecoveryStartResponse,
    status: 201,
  }),
  recoveryComplete: defineRoute({
    method: "POST",
    path: "/recovery-completions",
    auth: "none",
    summary: "Set a new password and recovery key with the grant; signs in",
    body: RecoveryCompleteRequest,
    response: RecoveryCompleteResponse,
  }),
  requestAccountReset: defineRoute({
    method: "POST",
    path: "/account-resets",
    auth: "none",
    summary:
      "Email a start-over link (the same answer for unknown emails; 429 when asked too often)",
    body: AccountResetRequest,
    response: Ok,
  }),
  completeAccountReset: defineRoute({
    method: "POST",
    path: "/account-reset-completions",
    auth: "none",
    summary: "Start over with new keys and the link's token; signs in (410 when the link expired)",
    body: AccountResetCompleteRequest,
    response: RecoveryCompleteResponse,
  }),
};
