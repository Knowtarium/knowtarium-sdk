import { fromBase64Url, toBase64Url } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { ciphertextSha256, recipientsHash, workspaceKeyCommitment } from "./hash.js";
import type { BoxKeyPair, SigningKeyPair } from "./keys.js";
import { type SignedEnvelope, signEnvelope, verifyEnvelopeFor } from "./signed-envelope.js";
import { wipe } from "./sodium.js";
import type { WorkspaceKey } from "./workspace-keys.js";
import { unwrapWorkspaceKeyUnverified, wrapWorkspaceKey } from "./wrap.js";

// Owner-signed wrapped keys. A sealed box proves nothing about who made it, so a server could
// wrap a key it knows for a recipient and have new data encrypted under it. Every wrapped
// workspace key therefore travels with a signed envelope from the workspace owner:
//
//   { type: "wrapped_key", accountId, workspaceId, recipient, holder, generation, ciphertextSha256,
//     createdAt }
//
// where `recipient` is the recipient's X25519 public key (base64url), `holder` is who holds the
// copy ("account" for the owner's own, or the agent's token id, so the server can't move a copy
// to another token's label) and `ciphertextSha256` is the SHA-256 of the wrapped bytes. A key generation needs the owner's word too, or a server could
// hand out a key generation of its own making: every generation has one owner-signed
//
//   { type: "key_generation", accountId, workspaceId, generation, recipientsHash, keyCommitment,
//     createdAt }
//
// which the server stores and returns with every wrapped copy. `keyCommitment` commits the owner
// to the generation's key itself (`workspaceKeyCommitment()`), checked after every unwrap, so two
// owner-signed key sets for one generation (a rotation body the server kept after answering an
// error, and the rotation that followed) can't be swapped for each other. `recipientsHash` commits the owner
// to the generation's recipient set (`recipientsHash()` of their public keys); adding a recipient
// to a generation (connecting an agent) re-signs it. Recipients verify both before unwrapping, so
// no generation is used without a valid owner signature, and a rotation re-wraps only for the
// owner-signed set of the generation it replaces. When the owner revokes an agent, they sign
//
//   { type: "token_revoked", accountId, workspaceId, recipient, tokenId, createdAt }
//
// so no later rotation, from any browser, wraps a key for that public key again.

/** The signed envelope type of a wrapped workspace key. */
export const WRAPPED_KEY_ENVELOPE_TYPE = "wrapped_key";

/** The signed envelope type of a workspace key generation. */
export const KEY_GENERATION_ENVELOPE_TYPE = "key_generation";

/** The signed envelope type of an owner's revocation of an agent token. */
export const TOKEN_REVOKED_ENVELOPE_TYPE = "token_revoked";

/** A workspace key wrapped for one recipient, with the owner's signatures over it. */
export interface SignedWrappedKey {
  /** The sealed box from `wrapWorkspaceKey`. */
  readonly wrapped: Uint8Array;
  /** The owner's signed "wrapped_key" envelope over `wrapped`. */
  readonly signed: SignedEnvelope;
  /** The owner's signed "key_generation" envelope for the key's generation. */
  readonly signedGeneration: SignedEnvelope;
}

/** Who must have signed a key generation, and for which workspace and generation. */
export interface KeyGenerationExpectation {
  /** The workspace owner's Ed25519 public key, from a source the server can't swap. */
  readonly ownerSigningPublicKey: Uint8Array;
  /** The owner's account id, when the verifier knows it. */
  readonly ownerAccountId?: string;
  readonly workspaceId: string;
  readonly generation: number;
  /** The recipient set the generation must commit to, when the verifier knows it. */
  readonly recipients?: readonly Uint8Array[];
  /** The key the generation must commit to, when the verifier holds it. */
  readonly key?: WorkspaceKey;
}

/** Who must have signed a wrapped key, and for which workspace and recipient. */
export interface WrappedKeyExpectation {
  /** The workspace owner's Ed25519 public key, from a source the server can't swap. */
  readonly ownerSigningPublicKey: Uint8Array;
  /** The owner's account id, when the verifier knows it. */
  readonly ownerAccountId?: string;
  readonly workspaceId: string;
  /** The X25519 public key the key must be wrapped for (the verifier's own). */
  readonly recipientPublicKey: Uint8Array;
  /** Who the copy must be for (`"account"` or a token id), when the verifier knows it. */
  readonly holder?: string;
}

/**
 * Signs an already wrapped workspace key as its owner. `createdAt` defaults to now. Internal:
 * the package exports `wrapAndSignWorkspaceKey`, which wraps and signs in one step.
 */
export function signWrappedKey(
  wrapped: Uint8Array,
  details: {
    readonly accountId: string;
    readonly workspaceId: string;
    readonly recipientPublicKey: Uint8Array;
    /** `"account"` (the owner's own copy) or the agent's token id. */
    readonly holder: string;
    readonly generation: number;
    readonly createdAt?: string;
  },
  ownerSigningKey: SigningKeyPair,
): SignedEnvelope {
  return signEnvelope(
    {
      type: WRAPPED_KEY_ENVELOPE_TYPE,
      accountId: details.accountId,
      workspaceId: details.workspaceId,
      recipient: toBase64Url(details.recipientPublicKey),
      holder: details.holder,
      generation: details.generation,
      ciphertextSha256: ciphertextSha256(wrapped),
      createdAt: details.createdAt ?? new Date().toISOString(),
    },
    ownerSigningKey,
  );
}

/**
 * Whether `signed` is the owner's valid "wrapped_key" envelope for exactly these wrapped bytes,
 * this workspace, this recipient and (when given) this holder. The generation is checked after unwrapping (see
 * `unwrapSignedWorkspaceKey`), since only the box reveals it.
 */
export function verifyWrappedKey(
  wrapped: Uint8Array,
  signed: SignedEnvelope,
  expected: WrappedKeyExpectation,
): boolean {
  const fields = {
    type: WRAPPED_KEY_ENVELOPE_TYPE,
    workspaceId: expected.workspaceId,
    recipient: toBase64Url(expected.recipientPublicKey),
    ciphertextSha256: ciphertextSha256(wrapped),
    ...(expected.holder === undefined ? {} : { holder: expected.holder }),
  } as const;
  return verifyEnvelopeFor(
    signed,
    expected.ownerSigningPublicKey,
    expected.ownerAccountId === undefined
      ? fields
      : { ...fields, accountId: expected.ownerAccountId },
  );
}

/**
 * Signs a workspace key generation as the owner: once per generation, when the workspace is
 * created (generation 1) and on every rotation. `createdAt` defaults to now.
 */
export function signKeyGeneration(
  details: {
    readonly accountId: string;
    readonly workspaceId: string;
    /** The generation's key: its generation and its commitment are signed. */
    readonly key: WorkspaceKey;
    /** Every recipient public key of the generation (the account's and each agent's). */
    readonly recipients: readonly Uint8Array[];
    readonly createdAt?: string;
  },
  ownerSigningKey: SigningKeyPair,
): SignedEnvelope {
  return signEnvelope(
    {
      type: KEY_GENERATION_ENVELOPE_TYPE,
      accountId: details.accountId,
      workspaceId: details.workspaceId,
      generation: details.key.generation,
      recipientsHash: recipientsHash(details.recipients),
      keyCommitment: workspaceKeyCommitment(details.key, details.workspaceId),
      createdAt: details.createdAt ?? new Date().toISOString(),
    },
    ownerSigningKey,
  );
}

/** Whether `signed` is the owner's valid "key_generation" envelope for this workspace and generation. */
export function verifyKeyGeneration(
  signed: SignedEnvelope,
  expected: KeyGenerationExpectation,
): boolean {
  const fields = {
    type: KEY_GENERATION_ENVELOPE_TYPE,
    workspaceId: expected.workspaceId,
    generation: expected.generation,
    ...(expected.recipients === undefined
      ? {}
      : { recipientsHash: recipientsHash(expected.recipients) }),
    ...(expected.key === undefined
      ? {}
      : { keyCommitment: workspaceKeyCommitment(expected.key, expected.workspaceId) }),
  } as const;
  return verifyEnvelopeFor(
    signed,
    expected.ownerSigningPublicKey,
    expected.ownerAccountId === undefined
      ? fields
      : { ...fields, accountId: expected.ownerAccountId },
  );
}

/**
 * Wraps a workspace key for a recipient and signs it as the owner, ready to upload. Pass the
 * generation's `signedGeneration` (from `signKeyGeneration`, naming every recipient) when
 * wrapping for several recipients; without it, one is signed for this recipient alone.
 */
export function wrapAndSignWorkspaceKey(
  key: WorkspaceKey,
  recipientPublicKey: Uint8Array,
  owner: {
    readonly accountId: string;
    readonly workspaceId: string;
    readonly signing: SigningKeyPair;
    /** Who holds the copy: `"account"` (the owner's own) or the agent's token id. */
    readonly holder: string;
    readonly signedGeneration?: SignedEnvelope;
  },
): SignedWrappedKey {
  const signedGeneration =
    owner.signedGeneration ??
    signKeyGeneration(
      {
        accountId: owner.accountId,
        workspaceId: owner.workspaceId,
        key,
        recipients: [recipientPublicKey],
      },
      owner.signing,
    );
  const generation = signedGeneration.envelope;
  if (
    generation.type !== KEY_GENERATION_ENVELOPE_TYPE ||
    generation.accountId !== owner.accountId ||
    generation.workspaceId !== owner.workspaceId ||
    generation.generation !== key.generation ||
    generation.keyCommitment !== workspaceKeyCommitment(key, owner.workspaceId)
  ) {
    throw new CryptoError("invalid_input", "signedGeneration is not for this key generation");
  }
  const wrapped = wrapWorkspaceKey(key, recipientPublicKey, owner.workspaceId);
  const signed = signWrappedKey(
    wrapped,
    {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      recipientPublicKey,
      holder: owner.holder,
      generation: key.generation,
    },
    owner.signing,
  );
  return { wrapped, signed, signedGeneration };
}

/**
 * Verifies the owner's signatures on the wrapped key and on its key generation, then unwraps,
 * then checks the unwrapped generation matches the signed one and the key matches the signed
 * generation's `keyCommitment`. Throws `invalid_signature` before
 * touching the box if either signature doesn't hold.
 */
export function unwrapSignedWorkspaceKey(
  signedKey: SignedWrappedKey,
  recipient: BoxKeyPair,
  expected: Omit<WrappedKeyExpectation, "recipientPublicKey">,
): WorkspaceKey {
  const { wrapped, signed, signedGeneration } = signedKey;
  if (
    !verifyWrappedKey(wrapped, signed, { ...expected, recipientPublicKey: recipient.publicKey })
  ) {
    throw new CryptoError("invalid_signature", "the wrapped key is not signed by the owner");
  }
  const generationSigned = verifyKeyGeneration(signedGeneration, {
    ownerSigningPublicKey: expected.ownerSigningPublicKey,
    ownerAccountId: signed.envelope.accountId,
    workspaceId: expected.workspaceId,
    generation: signed.envelope.generation ?? 0,
  });
  if (!generationSigned) {
    throw new CryptoError("invalid_signature", "the key generation is not signed by the owner");
  }
  const key = unwrapWorkspaceKeyUnverified(wrapped, recipient, expected.workspaceId);
  if (key.generation !== signed.envelope.generation) {
    wipe(key.key);
    throw new CryptoError("invalid_signature", "the wrapped key's generation doesn't match");
  }
  if (
    signedGeneration.envelope.keyCommitment !== workspaceKeyCommitment(key, expected.workspaceId)
  ) {
    wipe(key.key);
    throw new CryptoError(
      "invalid_signature",
      "the wrapped key isn't the one the owner signed for its generation",
    );
  }
  return key;
}

/**
 * Signs the owner's revocation of an agent token: its id and the X25519 public key its copies
 * were sealed for. `createdAt` defaults to now. Sent with `revokeToken`; the server returns it to
 * the owner's browsers, which never wrap a later key for that public key.
 */
export function signTokenRevocation(
  details: {
    readonly accountId: string;
    readonly workspaceId: string;
    readonly tokenId: string;
    readonly recipientPublicKey: Uint8Array;
    readonly createdAt?: string;
  },
  ownerSigningKey: SigningKeyPair,
): SignedEnvelope {
  return signEnvelope(
    {
      type: TOKEN_REVOKED_ENVELOPE_TYPE,
      accountId: details.accountId,
      workspaceId: details.workspaceId,
      recipient: toBase64Url(details.recipientPublicKey),
      tokenId: details.tokenId,
      createdAt: details.createdAt ?? new Date().toISOString(),
    },
    ownerSigningKey,
  );
}

/**
 * The revoked public key, when `signed` is the owner's valid "token_revoked" envelope for this
 * workspace; null otherwise.
 */
export function verifyTokenRevocation(
  signed: SignedEnvelope,
  expected: {
    readonly ownerSigningPublicKey: Uint8Array;
    readonly ownerAccountId?: string;
    readonly workspaceId: string;
  },
): Uint8Array | null {
  const fields = { type: TOKEN_REVOKED_ENVELOPE_TYPE, workspaceId: expected.workspaceId } as const;
  const valid = verifyEnvelopeFor(
    signed,
    expected.ownerSigningPublicKey,
    expected.ownerAccountId === undefined
      ? fields
      : { ...fields, accountId: expected.ownerAccountId },
  );
  const recipient = signed.envelope.recipient;
  if (!valid || recipient === undefined) return null;
  try {
    const key = fromBase64Url(recipient);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}
