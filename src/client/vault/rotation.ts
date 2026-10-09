import {
  fromBase64Url,
  isCryptoError,
  rotateWorkspaceKey,
  toBase64Url,
  verifyKeyGeneration,
  verifyTokenRevocation,
  verifyWrappedKey,
  type WorkspaceKeyring,
  workspaceKeyCommitment,
  wrapAndSignWorkspaceKey,
  WRAPPED_KEY_ACCOUNT_HOLDER,
} from "../../crypto/index.js";
import { toHex } from "../../crypto/encoding.js";
import {
  type ApproveConnectRequest,
  type KeyRecipient,
  type ListKeysResponse,
  type RecipientKey,
  type RotateKeyRequest,
  routes,
  type TokenRevocation,
  type WorkspaceId,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { RequestValidationError, VaultError } from "../errors/index.js";
import { signGeneration, signingHeaders, signRevocation } from "./envelopes.js";
import type { KeyProvider } from "./keys.js";
import type { Signer } from "./signer.js";
import type { TrustState } from "./trust.js";
import { toSignedEnvelope } from "./verify.js";

/** A recipient of a workspace key generation, from a verified envelope. */
export interface RotationRecipient {
  /**
   * Who holds the copy: the account, or an agent token. Proven by the owner-signed `holder` of
   * its `wrapped_key` envelope, so a server can't move a copy to another token's label.
   */
  readonly recipient: KeyRecipient;
  /** The recipient's X25519 public key, from the owner-signed `wrapped_key` envelope. */
  readonly publicKey: Uint8Array;
}

/** What a rotation's checks need, all from sources the server can't swap. */
export interface RotationExpectation {
  readonly workspaceId: string;
  /**
   * The generation the rotation replaces: the highest in the caller's own verified keyring
   * (`keys.current.generation`), never a number from the server.
   */
  readonly generation: number;
  /** The owner's Ed25519 public key (the web app's own account key). */
  readonly ownerSigningPublicKey: Uint8Array;
  readonly ownerAccountId?: string;
  /** The owner's own X25519 public key: the only key an `account` copy may carry. */
  readonly ownerBoxPublicKey: Uint8Array;
}

const keyId = (key: Uint8Array) => toHex(key);

/** The signed `holder` a copy labelled `recipient` must carry. */
const holderOf = (recipient: KeyRecipient): string =>
  recipient.kind === "account" ? WRAPPED_KEY_ACCOUNT_HOLDER : recipient.tokenId;

/**
 * The owner-signed recipient set of one generation: every copy of `expected.generation` whose
 * `wrapped_key` envelope verifies against the owner key (for exactly its wrapped bytes, this
 * workspace, the public key it names and the holder its label claims: `"account"` or the token
 * id), deduplicated by public key, checked against the generation's `recipientsHash` in an
 * owner-signed `key_generation`. An `account` copy must carry the owner's own box key, and a key
 * or a token appears under one holder only. Throws `untrusted_signature` when the copies don't
 * make up a set the owner signed (one left out, one added, a forged copy or a swapped label), so
 * a server can't add a key to a rotation or make one token's key pass for another's; it can only
 * make it fail, which the caller sees.
 */
export function generationRecipients(
  records: readonly RecipientKey[],
  expected: RotationExpectation,
): (RotationRecipient & { readonly revokedAt: string | null })[] {
  const owner = {
    ownerSigningPublicKey: expected.ownerSigningPublicKey,
    workspaceId: expected.workspaceId,
    ...(expected.ownerAccountId === undefined ? {} : { ownerAccountId: expected.ownerAccountId }),
  };
  const ownBox = keyId(expected.ownerBoxPublicKey);
  const found = new Map<string, RotationRecipient & { revokedAt: string | null }>();
  const keyOfHolder = new Map<string, string>();
  const generationEnvelopes: RecipientKey["signedGeneration"][] = [];
  for (const record of records) {
    if (record.workspaceId !== expected.workspaceId) continue;
    if (record.keyGeneration !== expected.generation) continue;
    const envelope = record.signed.envelope;
    const holder = holderOf(record.recipient);
    let publicKey: Uint8Array | null = null;
    try {
      if (envelope.type === "wrapped_key" && envelope.generation === expected.generation) {
        const candidate = fromBase64Url(envelope.recipient);
        if (
          verifyWrappedKey(fromBase64Url(record.encWorkspaceKey), toSignedEnvelope(record.signed), {
            ...owner,
            recipientPublicKey: candidate,
            holder,
          })
        ) {
          publicKey = candidate;
        }
      }
    } catch (error) {
      if (!isCryptoError(error)) throw error;
    }
    if (publicKey === null) {
      throw new VaultError(
        "untrusted_signature",
        "a copy of the workspace key isn't the owner's for the holder it is listed under",
      );
    }
    const id = keyId(publicKey);
    if (record.recipient.kind === "account" && id !== ownBox) {
      throw new VaultError("untrusted_signature", "the account's copy names another key");
    }
    const previous = found.get(id);
    if (
      (previous !== undefined && holderOf(previous.recipient) !== holder) ||
      (keyOfHolder.get(holder) ?? id) !== id
    ) {
      throw new VaultError("untrusted_signature", "a key or a token appears under two holders");
    }
    keyOfHolder.set(holder, id);
    generationEnvelopes.push(record.signedGeneration);
    found.set(id, {
      recipient: previous?.recipient ?? record.recipient,
      publicKey,
      // revoked if any copy for this key says so (leaving one out only ever denies)
      revokedAt: previous?.revokedAt ?? record.revokedAt,
    });
  }
  const keys = [...found.values()].map((entry) => entry.publicKey);
  if (keys.length === 0) {
    throw new VaultError("missing_key", "no copies of the current generation were listed");
  }
  const signed = generationEnvelopes.some((envelope) => {
    try {
      return verifyKeyGeneration(toSignedEnvelope(envelope), {
        ...owner,
        generation: expected.generation,
        recipients: keys,
      });
    } catch (error) {
      if (isCryptoError(error)) return false;
      throw error;
    }
  });
  if (!signed) {
    throw new VaultError(
      "untrusted_signature",
      "the listed copies aren't the recipient set the owner signed for this generation",
    );
  }
  return [...found.values()];
}

/** Every valid owner-signed revocation in `revocations`, by key, by token and by both. */
interface SignedRevocations {
  /** The revoked public keys, hex. */
  readonly keys: Set<string>;
  readonly tokenIds: Set<string>;
  /** `tokenId:keyHex` of each record: a token counts as revoked only with its own key. */
  readonly pairs: Set<string>;
  readonly publicKeys: readonly Uint8Array[];
  readonly records: readonly { readonly tokenId: string; readonly publicKey: Uint8Array }[];
}

const pairOf = (tokenId: string, publicKey: Uint8Array) => `${tokenId}:${keyId(publicKey)}`;

function signedRevocations(
  revocations: readonly TokenRevocation[],
  expected: RotationExpectation,
): SignedRevocations {
  const found = {
    keys: new Set<string>(),
    tokenIds: new Set<string>(),
    pairs: new Set<string>(),
  };
  const publicKeys: Uint8Array[] = [];
  const records: { tokenId: string; publicKey: Uint8Array }[] = [];
  for (const revocation of revocations) {
    if (revocation.workspaceId !== expected.workspaceId) continue;
    try {
      const signed = toSignedEnvelope(revocation.signed);
      const key = verifyTokenRevocation(signed, {
        ownerSigningPublicKey: expected.ownerSigningPublicKey,
        workspaceId: expected.workspaceId,
        ...(expected.ownerAccountId === undefined
          ? {}
          : { ownerAccountId: expected.ownerAccountId }),
      });
      const tokenId = signed.envelope.tokenId;
      if (key === null || tokenId === undefined) continue;
      found.keys.add(keyId(key));
      found.tokenIds.add(tokenId);
      found.pairs.add(pairOf(tokenId, key));
      publicKeys.push(key);
      records.push({ tokenId, publicKey: key });
    } catch (error) {
      if (!isCryptoError(error)) throw error;
    }
  }
  return { ...found, publicKeys, records };
}

/**
 * Checks the current generation's owner-signed recipient set on every keyring refresh (the
 * owner's view of `listKeys`): verifies it (`generationRecipients`), remembers in `trust` every
 * valid signed revocation it sees (so a server that later withholds the record changes nothing
 * here), records the set (`acceptGenerationSet`), and says whether a rotation is pending: the set
 * still holds a key this device knows as revoked, from a remembered or a signed revocation. That
 * includes a newer generation another owner device made without having seen the revocation;
 * writes are refused until a rotation from here leaves the key out.
 */
export async function currentGenerationState(
  records: readonly RecipientKey[],
  revocations: readonly TokenRevocation[],
  expected: RotationExpectation & { readonly trust: TrustState },
): Promise<{ readonly rotationPending: boolean }> {
  const { trust, workspaceId } = expected;
  const set = generationRecipients(records, expected);
  const ids = new Set(set.map((entry) => keyId(entry.publicKey)));
  const signed = signedRevocations(revocations, expected);
  const known = new Set(
    (await trust.revocations(workspaceId)).map((entry) => keyId(entry.publicKey)),
  );
  for (const revocation of signed.records) {
    if (known.has(keyId(revocation.publicKey))) continue;
    await trust.rememberRevocation(workspaceId, revocation, ids.has(keyId(revocation.publicKey)));
    known.add(keyId(revocation.publicKey));
  }
  await trust.acceptGenerationSet(
    workspaceId,
    expected.generation,
    set.map((entry) => entry.publicKey),
    signed.publicKeys,
  );
  const ownBox = keyId(expected.ownerBoxPublicKey);
  return { rotationPending: [...ids].some((id) => id !== ownBox && known.has(id)) };
}

/**
 * Who the next generation is wrapped for: the owner-signed set of the generation it replaces
 * (`generationRecipients`), without every key or token the owner revoked (a valid
 * `token_revoked`), every key in `exclude` (the token being revoked now, and the revocations the
 * device remembers), and every copy the server marks revoked (which can only leave a key out).
 * Deduplicated by public key; the owner's own account copy always stays.
 */
export function rotationRecipients(
  records: readonly RecipientKey[],
  revocations: readonly TokenRevocation[],
  expected: RotationExpectation & { readonly exclude?: readonly Uint8Array[] },
): { readonly recipients: RotationRecipient[]; readonly excluded: RotationRecipient[] } {
  const set = generationRecipients(records, expected);
  const revoked = signedRevocations(revocations, expected);
  const removed = new Set([...(expected.exclude ?? []).map(keyId), ...revoked.keys]);
  const ownBox = keyId(expected.ownerBoxPublicKey);
  const recipients: RotationRecipient[] = [];
  const excluded: RotationRecipient[] = [];
  for (const entry of set) {
    const id = keyId(entry.publicKey);
    const tokenRevoked =
      entry.recipient.kind === "token" && revoked.tokenIds.has(entry.recipient.tokenId);
    const keep = id === ownBox || (!removed.has(id) && !tokenRevoked && entry.revokedAt === null);
    (keep ? recipients : excluded).push({ recipient: entry.recipient, publicKey: entry.publicKey });
  }
  if (!recipients.some((entry) => keyId(entry.publicKey) === ownBox)) {
    throw new VaultError(
      "missing_key",
      "the owner's own copy of the current generation is missing",
    );
  }
  return { recipients, excluded };
}

/**
 * A rotation's request: the next generation of the key, the owner's `key_generation` naming
 * exactly `recipients`, and the key wrapped and signed for each (with its signed `holder`).
 * Returns the new key too.
 */
export function prepareRotation(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly current: WorkspaceKeyring["current"];
    readonly recipients: readonly RotationRecipient[];
  },
): { readonly request: RotateKeyRequest; readonly key: WorkspaceKeyring["current"] } {
  const key = rotateWorkspaceKey(details.current);
  const generation = signGeneration(signer, {
    workspaceId: details.workspaceId,
    key,
    recipients: details.recipients.map((entry) => entry.publicKey),
    route: "rotateWorkspaceKey",
  });
  const wrappedKeys = details.recipients.map((entry) => {
    const wrapped = wrapAndSignWorkspaceKey(key, entry.publicKey, {
      accountId: signer.accountId,
      workspaceId: details.workspaceId,
      signing: signer.signing,
      holder: holderOf(entry.recipient),
      signedGeneration: generation.signed,
    });
    return {
      recipient: entry.recipient,
      encWorkspaceKey: toBase64Url(wrapped.wrapped),
      signedAt: wrapped.signed.envelope.createdAt,
      signature: wrapped.signed.signature,
    };
  });
  return {
    key,
    request: {
      keyGeneration: key.generation,
      keyCommitment: generation.keyCommitment,
      generationSignedAt: generation.generationSignedAt,
      generationSignature: generation.generationSignature,
      wrappedKeys,
    },
  };
}

/** What the owner's rotation flows need (session, the workspace owner). */
export interface OwnerKeyFlow {
  readonly workspaceId: WorkspaceId;
  readonly signer: Signer;
  /** The owner's own X25519 public key (the account's). */
  readonly ownerBoxPublicKey: Uint8Array;
  /** The owner's verified keyring: the generation always comes from here. */
  readonly keys: KeyProvider;
  /** This device's memory: the recipient sets seen and the revocations still to rotate out. */
  readonly trust: TrustState;
}

function expectationOf(flow: OwnerKeyFlow, generation: number): RotationExpectation {
  return {
    workspaceId: flow.workspaceId,
    generation,
    ownerSigningPublicKey: flow.signer.signing.publicKey,
    ownerAccountId: flow.signer.accountId,
    ownerBoxPublicKey: flow.ownerBoxPublicKey,
  };
}

async function ownerKeys(api: ApiClient): Promise<{
  readonly records: RecipientKey[];
  readonly revocations: TokenRevocation[];
}> {
  const { data }: { data: ListKeysResponse } = await api.call(routes.listKeys);
  return { records: data.recipients ?? [], revocations: data.revocations ?? [] };
}

/**
 * Rotates the workspace key: wraps a new generation for the owner-signed set of the current one
 * (from the refreshed keyring) without every revoked key (`rotationRecipients`, with every
 * revocation this device remembers in `trust` added to `exclude`), stores it, pins the new key's
 * commitment in `trust`, reads the keys back and checks the server now serves exactly the key it
 * just created for the new generation (`untrusted_signature` otherwise: a server serving another
 * owner-signed set for that generation, such as a rotation body it kept after answering an error,
 * is caught here and on every later read, since the commitment is pinned). Then it marks the
 * remembered revocations done. The verified sets are recorded in `trust` (`acceptGenerationSet`).
 * Returns the new generation, who it was wrapped for and who was left out.
 */
export async function rotateWorkspace(
  api: ApiClient,
  flow: OwnerKeyFlow & { readonly exclude?: readonly Uint8Array[] },
): Promise<{
  readonly generation: number;
  readonly recipients: readonly RotationRecipient[];
  readonly excluded: readonly RotationRecipient[];
}> {
  const { workspaceId, trust } = flow;
  const keyring = await flow.keys.refresh();
  const expected = expectationOf(flow, keyring.current.generation);
  const { records, revocations } = await ownerKeys(api);
  const remembered = await trust.revocations(workspaceId);
  const { recipients, excluded } = rotationRecipients(records, revocations, {
    ...expected,
    exclude: [...remembered.map((entry) => entry.publicKey), ...(flow.exclude ?? [])],
  });
  await trust.acceptGenerationSet(
    workspaceId,
    expected.generation,
    [...recipients, ...excluded].map((entry) => entry.publicKey),
    signedRevocations(revocations, expected).publicKeys,
  );
  const { request, key } = prepareRotation(flow.signer, {
    workspaceId,
    current: keyring.current,
    recipients,
  });
  await api.call(routes.rotateWorkspaceKey, { params: { workspaceId }, body: request });
  const commitment = workspaceKeyCommitment(key, workspaceId);
  // accepted: from now on this device refuses any older generation (a server that answered 200
  // and then serves only the old one can't keep it writing under a key the revoked agent holds)
  await trust.acceptKeyGeneration(workspaceId, key.generation);
  await trust.acceptKeyCommitment(workspaceId, key.generation, commitment);
  await trust.acceptGenerationSet(
    workspaceId,
    key.generation,
    recipients.map((entry) => entry.publicKey),
  );
  const stored = await flow.keys.refresh();
  if (
    stored.current.generation !== key.generation ||
    workspaceKeyCommitment(stored.current, workspaceId) !== commitment
  ) {
    throw new VaultError(
      "untrusted_signature",
      "the server serves another key than the one just created for the new generation",
    );
  }
  await trust.settleRevocations(workspaceId);
  return { generation: key.generation, recipients, excluded };
}

/**
 * Revokes an agent token and rotates the workspace key in one flow (session, the workspace
 * owner). The token's public key comes from its owner-signed copy of the current generation (the
 * copy whose signed `holder` is `tokenId`), or from this device's memory of an earlier attempt.
 * The revocation is remembered in `trust` before anything is sent; the signed `token_revoked` is
 * sent whenever no valid record for that token and key is listed (whatever this device
 * remembers), then `rotateWorkspace` wraps a new generation without the key, unless the current
 * generation already leaves it out. Resumable: when the revoke or the rotation fails (network, a
 * conflict), run it again; it sends what is still missing. Returns the current generation (the
 * new one after a rotation) and who holds it.
 */
export async function revokeAndRotate(
  api: ApiClient,
  flow: OwnerKeyFlow & { readonly tokenId: string },
): Promise<{ readonly generation: number; readonly recipients: readonly RotationRecipient[] }> {
  const { workspaceId, trust, tokenId } = flow;
  const keyring = await flow.keys.refresh();
  const expected = expectationOf(flow, keyring.current.generation);
  const { records, revocations } = await ownerKeys(api);
  const revoked = signedRevocations(revocations, expected);
  const set = generationRecipients(records, expected);
  await trust.acceptGenerationSet(
    workspaceId,
    expected.generation,
    set.map((entry) => entry.publicKey),
    revoked.publicKeys,
  );
  const inSet = set.find(
    (entry) => entry.recipient.kind === "token" && entry.recipient.tokenId === tokenId,
  );
  const publicKey =
    inSet?.publicKey ??
    (await trust.revocations(workspaceId)).find((entry) => entry.tokenId === tokenId)?.publicKey;
  if (publicKey === undefined) {
    if (revoked.tokenIds.has(tokenId)) {
      // revoked and rotated out elsewhere: nothing left to do
      return { generation: expected.generation, recipients: set.map(withoutMark) };
    }
    throw new VaultError("missing_key", "the token holds no copy of the current generation");
  }
  await trust.rememberRevocation(workspaceId, { tokenId, publicKey });
  if (!revoked.pairs.has(pairOf(tokenId, publicKey))) {
    const revocation = signRevocation(flow.signer, {
      workspaceId,
      tokenId,
      recipientPublicKey: publicKey,
    });
    await api.call(routes.revokeToken, {
      params: { tokenId },
      headers: signingHeaders(revocation),
    });
  }
  if (inSet === undefined) {
    // the current generation already leaves the key out (an earlier rotation)
    await trust.settleRevocations(workspaceId);
    return { generation: expected.generation, recipients: set.map(withoutMark) };
  }
  const { generation, recipients } = await rotateWorkspace(api, { ...flow, exclude: [publicKey] });
  return { generation, recipients };
}

const withoutMark = ({ recipient, publicKey }: RotationRecipient): RotationRecipient => ({
  recipient,
  publicKey,
});

/** The key fields of an `approveConnect` request, from `prepareConnectGeneration`. */
export type ConnectKeyFields = Pick<
  ApproveConnectRequest,
  | "publicKey"
  | "keyGeneration"
  | "encWorkspaceKey"
  | "signedAt"
  | "signature"
  | "keyCommitment"
  | "generationSignedAt"
  | "generationSignature"
>;

/**
 * The key fields of an `approveConnect` request (session, the workspace owner): the current key
 * (from the refreshed keyring) wrapped for the new agent's public key with the signed `holder`
 * `tokenId`, and the current generation's `key_generation` signed again over its owner-signed set
 * (`generationRecipients`, which must hold the owner's own key) plus the new key. Refuses
 * (`RequestValidationError`) a key that is already a recipient, a token id that already holds a
 * copy, or a revoked key or token. Remembers the approval in `trust` (`rememberApproval`), so
 * revoking that agent before this device saw the grown set still works.
 */
export async function prepareConnectGeneration(
  api: ApiClient,
  flow: OwnerKeyFlow & { readonly tokenId: string; readonly agentPublicKey: Uint8Array },
): Promise<ConnectKeyFields> {
  const { workspaceId, trust, tokenId, agentPublicKey } = flow;
  const keyring = await flow.keys.refresh();
  const key = keyring.current;
  const expected = expectationOf(flow, key.generation);
  const { records, revocations } = await ownerKeys(api);
  const set = generationRecipients(records, expected);
  if (!set.some((entry) => keyId(entry.publicKey) === keyId(flow.ownerBoxPublicKey))) {
    throw new VaultError(
      "missing_key",
      "the owner's own copy of the current generation is missing",
    );
  }
  const revoked = signedRevocations(revocations, expected);
  await trust.acceptGenerationSet(
    workspaceId,
    key.generation,
    set.map((entry) => entry.publicKey),
    revoked.publicKeys,
  );
  const agent = keyId(agentPublicKey);
  const remembered = await trust.revocations(workspaceId);
  if (
    set.some((entry) => keyId(entry.publicKey) === agent) ||
    revoked.keys.has(agent) ||
    remembered.some((entry) => keyId(entry.publicKey) === agent)
  ) {
    throw new RequestValidationError("approveConnect", "body", ["publicKey"]);
  }
  if (
    set.some((entry) => entry.recipient.kind === "token" && entry.recipient.tokenId === tokenId) ||
    revoked.tokenIds.has(tokenId)
  ) {
    throw new RequestValidationError("approveConnect", "body", ["tokenId"]);
  }
  const generation = signGeneration(flow.signer, {
    workspaceId,
    key,
    recipients: [...set.map((entry) => entry.publicKey), agentPublicKey],
    route: "approveConnect",
  });
  // signed: the server may store it whatever happens next, so this device expects the key there
  await trust.rememberApproval(workspaceId, key.generation, agentPublicKey);
  const wrapped = wrapAndSignWorkspaceKey(key, agentPublicKey, {
    accountId: flow.signer.accountId,
    workspaceId,
    signing: flow.signer.signing,
    holder: tokenId,
    signedGeneration: generation.signed,
  });
  return {
    publicKey: toBase64Url(agentPublicKey),
    keyGeneration: key.generation,
    encWorkspaceKey: toBase64Url(wrapped.wrapped),
    signedAt: wrapped.signed.envelope.createdAt,
    signature: wrapped.signed.signature,
    keyCommitment: generation.keyCommitment,
    generationSignedAt: generation.generationSignedAt,
    generationSignature: generation.generationSignature,
  };
}
