import {
  type AccountKeys,
  assertKdfParams,
  createAccount,
  createRecovery,
  derivePasswordSecrets,
  type PasswordKdfParams,
  toBase64Url,
  wipe,
} from "../../crypto/index.js";
import {
  type AccountResetCompleteRequest,
  type ChangePlanResponse,
  type KdfParams,
  type PlanChoice,
  type RecoveryCompleteResponse,
  type ReplaceRecoveryKeyRequest,
  routes,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { VaultError } from "../errors/index.js";
import type { TrustState } from "./trust.js";

/** The protocol's KDF parameters as `knowtarium/crypto` takes them. */
export function toPasswordKdfParams(kdf: KdfParams): PasswordKdfParams {
  return {
    algorithm: kdf.algorithm,
    opsLimit: kdf.opsLimit,
    memLimit: kdf.memLimitBytes,
    salt: kdf.salt,
  };
}

/** Crypto's KDF parameters as the protocol sends them (sign-up, password change). */
export function fromPasswordKdfParams(params: PasswordKdfParams): KdfParams {
  return {
    algorithm: params.algorithm,
    opsLimit: params.opsLimit,
    memLimitBytes: params.memLimit,
    salt: params.salt,
  };
}

/**
 * Checks a prelogin answer before deriving anything: crypto's fixed floor and ceiling, then the
 * strongest parameters this device saw for the email, so a server can't downgrade them. Record
 * them with `trust.recordKdfParams(email, kdf)` only after the unlock succeeds.
 */
export async function checkPreloginKdf(
  trust: TrustState,
  email: string,
  kdf: KdfParams,
): Promise<PasswordKdfParams> {
  const params = toPasswordKdfParams(kdf);
  assertKdfParams(params);
  await trust.checkKdfParams(email, kdf);
  return params;
}

/** A new recovery key for a signed-in account: the request to send and the code to show once. */
export interface RecoveryKeyReplacement {
  readonly request: ReplaceRecoveryKeyRequest;
  /** Show it once and ask the person to save it; never store or send it. */
  readonly recoveryCode: string;
}

/**
 * Prepares `replaceRecoveryKey` from the unlocked account keys and the current password: the
 * current login hash (Argon2id with the account's KDF parameters as `getAccount` returned them,
 * checked first against crypto's floor and the strongest this device saw for the email; run it
 * in a Web Worker), and a new recovery key wrapping the same secret keys. No content is
 * re-encrypted. Keep the result until the server confirms: a lost answer is retried with the
 * same request (`sendRecoveryKeyReplacement`), so the code shown is the one that took.
 */
export async function prepareRecoveryKeyReplacement(
  keys: AccountKeys,
  current: {
    readonly password: string;
    readonly kdf: KdfParams;
    readonly email: string;
    readonly trust: TrustState;
  },
): Promise<RecoveryKeyReplacement> {
  const params = await checkPreloginKdf(current.trust, current.email, current.kdf);
  const { authHash, keyEncryptionKey } = derivePasswordSecrets(current.password, params);
  wipe(keyEncryptionKey);
  const recovery = createRecovery(keys);
  try {
    return {
      request: {
        currentLoginHash: toBase64Url(authHash),
        wrappedByRecovery: { encSecretKeys: toBase64Url(recovery.wrappedByRecovery) },
        recoveryAuthHash: toBase64Url(recovery.recoveryAuthHash),
      },
      recoveryCode: recovery.recoveryCode,
    };
  } finally {
    wipe(authHash, recovery.recoveryAuthHash);
  }
}

/**
 * Sends a prepared replacement (idempotent: the same request may be sent again; the API client
 * retries it after network errors). After a failure, call it again with the same `replacement`
 * so the code the person saved is the one that takes effect.
 */
export async function sendRecoveryKeyReplacement(
  api: ApiClient,
  replacement: RecoveryKeyReplacement,
): Promise<string> {
  await api.call(routes.replaceRecoveryKey, { body: replacement.request, idempotent: true });
  return replacement.recoveryCode;
}

/**
 * Replaces the account's recovery key (session): prepares it and sends it, returning the new
 * recovery code only once the server accepted it. A wrong password comes back as the server's
 * error and nothing changes. When sending fails, the error is a `RecoveryKeyReplacementError`
 * holding the prepared replacement: retry with `sendRecoveryKeyReplacement(api, error.replacement)`
 * rather than preparing a new one.
 */
export async function replaceRecoveryKey(
  api: ApiClient,
  keys: AccountKeys,
  current: {
    readonly password: string;
    readonly kdf: KdfParams;
    readonly email: string;
    readonly trust: TrustState;
  },
): Promise<string> {
  const replacement = await prepareRecoveryKeyReplacement(keys, current);
  try {
    return await sendRecoveryKeyReplacement(api, replacement);
  } catch (error) {
    throw new RecoveryKeyReplacementError(replacement, error);
  }
}

/** Sending a recovery key replacement failed; `replacement` retries the same request. */
export class RecoveryKeyReplacementError extends Error {
  override readonly name = "RecoveryKeyReplacementError";

  constructor(
    readonly replacement: RecoveryKeyReplacement,
    override readonly cause: unknown,
  ) {
    super("The new recovery key wasn't confirmed; send the same request again.", { cause });
  }
}

/** A start-over, prepared: the request (a whole new account's keys, made like at sign-up). */
export interface StartOver {
  readonly request: AccountResetCompleteRequest;
  /** The new account keys, unlocked: keep them in memory like after a sign-in. */
  readonly keys: AccountKeys;
  /** Show it once and ask the person to save it; never store or send it. */
  readonly recoveryCode: string;
}

/**
 * Prepares `completeAccountReset` from the link's token and the new password: fresh account keys,
 * the login hash, both wrapped copies and a new recovery code, exactly as at sign-up (Argon2id:
 * run it in a Web Worker). Nothing of the old account is kept; what was encrypted under the old
 * keys can't be read again.
 */
export function prepareStartOver(resetToken: string, password: string): StartOver {
  const account = createAccount(password);
  return {
    keys: account.keys,
    recoveryCode: account.recoveryCode,
    request: {
      resetToken,
      loginHash: toBase64Url(account.loginHash),
      kdf: fromPasswordKdfParams(account.kdfParams),
      publicKeys: {
        box: toBase64Url(account.publicKeys.encryptionPublicKey),
        sign: toBase64Url(account.publicKeys.signingPublicKey),
      },
      wrappedByMaster: { encSecretKeys: toBase64Url(account.wrappedByPassword) },
      wrappedByRecovery: { encSecretKeys: toBase64Url(account.wrappedByRecovery) },
      recoveryAuthHash: toBase64Url(account.recoveryAuthHash),
    },
  };
}

/** Asks for a start-over link by email (the same answer whether or not the email has an account). */
export async function requestStartOver(api: ApiClient, email: string): Promise<void> {
  await api.call(routes.requestAccountReset, { body: { email } });
}

/**
 * Starts over (no session needed): new keys and password with the token from the email link,
 * then signed in. The server answers 410 `expired` for a used or old link. Pass this device's
 * `trust` to pin the new account keys at once (the person started over here; any other device
 * re-pins with `TrustState.acceptAccountReset`, with the password as proof, after the person
 * confirms there).
 */
export async function startOver(
  api: ApiClient,
  details: {
    readonly resetToken: string;
    readonly password: string;
    /**
     * The account being started over (known from this device's sign-in or the link); the server's
     * answer must name it (`pin_mismatch` otherwise).
     */
    readonly accountId: string;
    /** This device's trust state: the new keys are pinned at once (the person started over here). */
    readonly trust?: TrustState;
  },
): Promise<{
  readonly account: RecoveryCompleteResponse["account"];
  readonly keys: AccountKeys;
  readonly recoveryCode: string;
}> {
  const prepared = prepareStartOver(details.resetToken, details.password);
  const { data } = await api.call(routes.completeAccountReset, { body: prepared.request });
  if (data.account.id !== details.accountId) {
    throw new VaultError("pin_mismatch", "the server started over another account");
  }
  await details.trust?.acceptAccountReset(details.accountId, {
    password: details.password,
    material: prepared.request,
  });
  return { account: data.account, keys: prepared.keys, recoveryCode: prepared.recoveryCode };
}

/**
 * A link to the billing portal for the signed-in account (invoices, payment method, cancelling).
 * The server answers 404 `not_found` without a subscription and 503 `unavailable` when the
 * payment provider can't be reached.
 */
export async function createPortalSession(api: ApiClient): Promise<string> {
  const { data } = await api.call(routes.createPortalSession);
  return data.url;
}

/**
 * The payment provider's hosted checkout for a plan and interval on sale (from `offers`), bound
 * to the signed-in account by the server. The server answers 403 `email_not_verified` until the
 * account's email is verified, 404 `not_found` for a plan or interval not on sale, 409
 * `already_exists` while a subscription is live (change it with `changePlan` instead) and 503
 * `unavailable` when checkout isn't configured on the server or the provider can't be reached.
 */
export async function startCheckout(api: ApiClient, choice: PlanChoice): Promise<string> {
  const { data } = await api.call(routes.startCheckout, {
    body: { planId: choice.planId, interval: choice.interval },
  });
  return data.url;
}

/**
 * Moves the live subscription to another plan or interval on sale: an upgrade applies now with the
 * difference charged (`effect: "applied"`), anything else at the renewal (`"scheduled"`, with
 * `appliesAt`). `planChangeEffect` says which before asking. Refusals are listed at
 * `ChangePlanRequest`: notably 404 `not_found` without a live subscription (use `startCheckout`),
 * 409 `subscription_not_changeable` (fix it in the billing portal first) and 402
 * `payment_failed` (nothing changed; send the person to the billing portal).
 */
export async function changePlan(api: ApiClient, choice: PlanChoice): Promise<ChangePlanResponse> {
  const { data } = await api.call(routes.changePlan, {
    body: { planId: choice.planId, interval: choice.interval },
  });
  return data;
}

/**
 * Drops the plan change scheduled for the renewal (`subscription.pendingChange`); fine when none
 * is. 404 `not_found` without a live subscription.
 */
export async function cancelPlanChange(api: ApiClient): Promise<void> {
  await api.call(routes.cancelPlanChange);
}
