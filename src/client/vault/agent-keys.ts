import {
  fromBase64Url,
  type SignedEnvelope,
  type SignedEnvelopeFields,
  verifyEnvelopeFor,
  verifyTokenRevocation,
} from "../../crypto/index.js";
import type {
  AgentKeyRecord,
  ListKeysResponse,
  SignedAgentKey,
  SignedEvent,
  TokenRevocation,
} from "../../protocol/index.js";
import type { TrustedSigner } from "./verify.js";

/** A protocol signed record in the form `knowtarium/crypto` verifies (as `toSignedEnvelope`). */
function asEnvelope(signed: SignedEvent | SignedAgentKey): SignedEnvelope {
  return {
    version: 1,
    envelope: signed.envelope as SignedEnvelopeFields,
    signature: signed.signature,
  };
}

/*
 * Agent signing keys (protocol 2). An agent's direct write (`agent_edited`) counts only under an
 * Ed25519 key the workspace owner vouched for with a signed `agent_key` naming the same token.
 * The keys come from `listKeys` (`agentKeys`) and are verified here against the owner's key from
 * a source the server can't swap, so callers keep passing only the owner key.
 *
 * Revocation: a revoked agent's versions written before the revocation stay valid and are flagged
 * (`revoked`); with the owner's signed `token_revoked` at hand (an owner session's `listKeys`
 * `revocations`), an `agent_edited` dated after it is refused. An agent caller gets no signed
 * revocations, only the server's `revokedAt`, which flags but never refuses.
 */

/** An agent's signing key the owner vouched for, verified. */
export interface VerifiedAgentKey {
  readonly tokenId: string;
  /** The agent's Ed25519 public key, from the verified `agent_key`. */
  readonly publicKey: Uint8Array;
  /** The agent policy revision when the agent connected: its floor. */
  readonly policyRevision: number;
  readonly signed: SignedAgentKey;
  /** Whether the agent was revoked (a signed revocation, or the server's `revokedAt`). */
  readonly revoked: boolean;
  /** When: the server's `revokedAt`, else the signed revocation's time; null when not revoked. */
  readonly revokedAt: string | null;
  /** The `createdAt` of the owner's verified `token_revoked`, when one is known. */
  readonly revokedSignedAt: string | null;
  /** That verified revocation itself (to keep, so later checks still refuse after it). */
  readonly revocation: SignedEvent | null;
}

/** Why `verifyAgentEdited` refused an agent's signed write. */
export type AgentEditedProblem =
  /** Not an `agent_edited` envelope. */
  | "not_agent_edited"
  /** The `agent_key` doesn't verify under the owner's key (or isn't for this workspace). */
  | "unvouched_key"
  /** The two envelopes name another token, workspace or account. */
  | "mismatch"
  /** The `agent_edited` signature doesn't verify under the vouched key, or names other fields. */
  | "bad_signature"
  /** Signed after the owner revoked the agent. */
  | "after_revocation";

export type AgentEditedCheck =
  | { readonly ok: true; readonly tokenId: string; readonly revoked: boolean }
  | { readonly ok: false; readonly problem: AgentEditedProblem };

/**
 * Verifies an owner-signed `agent_key` (for `workspaceId`, signed by `owner`) and returns the key
 * it vouches for; null when it doesn't verify. `revocation`, the owner's signed `token_revoked`
 * for the token if any, is verified too; `revokedAt` is the server's word (flag only).
 */
export function verifyAgentKey(
  signed: SignedAgentKey,
  owner: TrustedSigner,
  workspaceId: string,
  revocation?: {
    readonly signed?: SignedEvent | null;
    readonly revokedAt?: string | null;
  },
): VerifiedAgentKey | null {
  const fields = signed.envelope;
  const ok = verifyEnvelopeFor(asEnvelope(signed), owner.publicKey, {
    type: "agent_key",
    workspaceId,
    ...(owner.accountId === undefined ? {} : { accountId: owner.accountId }),
  });
  if (!ok) return null;
  let publicKey: Uint8Array;
  try {
    publicKey = fromBase64Url(fields.signPublicKey);
  } catch {
    return null;
  }
  if (publicKey.length !== 32) return null;
  const signedRevocation =
    revocation?.signed == null ? null : revocationTime(revocation.signed, fields, owner);
  return {
    tokenId: fields.tokenId,
    publicKey,
    policyRevision: fields.policyRevision,
    signed,
    revoked: signedRevocation !== null || (revocation?.revokedAt ?? null) !== null,
    revokedAt: revocation?.revokedAt ?? signedRevocation,
    revokedSignedAt: signedRevocation,
    revocation: signedRevocation === null ? null : (revocation?.signed ?? null),
  };
}

/** The `createdAt` of a valid owner-signed revocation of the `agent_key`'s token, else null. */
function revocationTime(
  signed: SignedEvent,
  key: SignedAgentKey["envelope"],
  owner: TrustedSigner,
): string | null {
  const fields = signed.envelope;
  if (fields.type !== "token_revoked" || fields.tokenId !== key.tokenId) return null;
  if (fields.accountId !== key.accountId) return null;
  const recipient = verifyTokenRevocation(asEnvelope(signed), {
    ownerSigningPublicKey: owner.publicKey,
    workspaceId: key.workspaceId,
    ...(owner.accountId === undefined ? {} : { ownerAccountId: owner.accountId }),
  });
  return recipient === null ? null : fields.createdAt;
}

/**
 * Checks an agent's signed write against a key already verified (`verifyAgentKey`): the same
 * token, workspace and account in both, the signature under the vouched key, every field in
 * `expected` equal, and not signed after a known signed revocation.
 */
export function checkAgentEdited(
  signed: SignedEvent,
  key: VerifiedAgentKey,
  expected: Partial<SignedEnvelopeFields> = {},
): AgentEditedCheck {
  const fields = signed.envelope;
  if (fields.type !== "agent_edited") return { ok: false, problem: "not_agent_edited" };
  const vouched = key.signed.envelope;
  if (
    fields.tokenId !== vouched.tokenId ||
    fields.workspaceId !== vouched.workspaceId ||
    fields.accountId !== vouched.accountId
  ) {
    return { ok: false, problem: "mismatch" };
  }
  const ok = verifyEnvelopeFor(asEnvelope(signed), key.publicKey, {
    ...expected,
    type: "agent_edited",
    tokenId: vouched.tokenId,
    workspaceId: vouched.workspaceId,
    accountId: vouched.accountId,
  });
  if (!ok) return { ok: false, problem: "bad_signature" };
  if (
    key.revokedSignedAt !== null &&
    Date.parse(fields.createdAt) > Date.parse(key.revokedSignedAt)
  ) {
    return { ok: false, problem: "after_revocation" };
  }
  return { ok: true, tokenId: vouched.tokenId, revoked: key.revoked };
}

/**
 * Verifies an agent's direct write from scratch: the owner-signed `agent_key` under the owner's
 * key, the same token, workspace and account in both, the `agent_edited` signature under the key
 * it vouches for (with `expected`'s fields equal), and, given the owner's signed `token_revoked`,
 * no `createdAt` after it. A write by a revoked agent from before its revocation passes, flagged
 * `revoked` (also when only the server's `revokedAt` says so).
 */
export function verifyAgentEdited(
  signedEvent: SignedEvent,
  signedAgentKey: SignedAgentKey,
  owner: TrustedSigner,
  options: {
    readonly revocation?: SignedEvent | null;
    readonly revokedAt?: string | null;
    readonly expected?: Partial<SignedEnvelopeFields>;
  } = {},
): AgentEditedCheck {
  if (signedEvent.envelope.type !== "agent_edited") {
    return { ok: false, problem: "not_agent_edited" };
  }
  const key = verifyAgentKey(signedAgentKey, owner, signedEvent.envelope.workspaceId, {
    signed: options.revocation ?? null,
    revokedAt: options.revokedAt ?? null,
  });
  if (key === null) return { ok: false, problem: "unvouched_key" };
  return checkAgentEdited(signedEvent, key, options.expected);
}

/**
 * Every agent key of a workspace from `listKeys` that verifies under the owner's key, by token
 * (a token normally has one), each with its revocation: the owner's signed `token_revoked` from
 * `revocations` when listed, else the record's `revokedAt`. Records that don't verify are left
 * out, so a version signed under them is refused.
 */
export function verifiedAgentKeys(
  data: Pick<ListKeysResponse, "agentKeys" | "revocations">,
  owner: TrustedSigner,
  workspaceId: string,
): Map<string, VerifiedAgentKey[]> {
  const revocations = new Map<string, TokenRevocation[]>();
  for (const revocation of data.revocations ?? []) {
    if (revocation.workspaceId !== workspaceId) continue;
    revocations.set(revocation.tokenId, [
      ...(revocations.get(revocation.tokenId) ?? []),
      revocation,
    ]);
  }
  const keys = new Map<string, VerifiedAgentKey[]>();
  const seen = new Set<string>();
  for (const record of data.agentKeys ?? []) {
    // an owner gets every workspace's keys: only this one's are verified, each once
    if (record.signed.envelope.workspaceId !== workspaceId) continue;
    if (seen.has(record.signed.signature)) continue;
    seen.add(record.signed.signature);
    const key = verifyRecord(record, owner, workspaceId, revocations);
    if (key !== null) keys.set(key.tokenId, [...(keys.get(key.tokenId) ?? []), key]);
  }
  return keys;
}

function verifyRecord(
  record: AgentKeyRecord,
  owner: TrustedSigner,
  workspaceId: string,
  revocations: ReadonlyMap<string, readonly TokenRevocation[]>,
): VerifiedAgentKey | null {
  const tokenId = record.signed.envelope.tokenId;
  const candidates = revocations.get(tokenId) ?? [];
  let best = verifyAgentKey(record.signed, owner, workspaceId, { revokedAt: record.revokedAt });
  // the earliest valid signed revocation is the one that counts
  for (const candidate of candidates) {
    const key = verifyAgentKey(record.signed, owner, workspaceId, {
      signed: candidate.signed,
      revokedAt: record.revokedAt,
    });
    if (key?.revokedSignedAt == null) continue;
    if (
      best?.revokedSignedAt == null ||
      Date.parse(key.revokedSignedAt) < Date.parse(best.revokedSignedAt)
    ) {
      best = key;
    }
  }
  return best;
}
