import {
  ciphertextSha256,
  type SignedEnvelope,
  type SignedEnvelopeFields,
  verifyEnvelopeFor,
} from "../../crypto/index.js";
import type { NoteEvent, SignedAgentPolicy, SignedEvent } from "../../protocol/index.js";
import { VaultError } from "../errors/index.js";
import { checkAgentEdited, type VerifiedAgentKey } from "./agent-keys.js";

/** A protocol signed event (`{ envelope, signature }`) in the form `knowtarium/crypto` verifies. */
export function toSignedEnvelope(event: SignedEvent): SignedEnvelope {
  return {
    version: 1,
    envelope: event.envelope as SignedEnvelopeFields,
    signature: event.signature,
  };
}

/** Who must have signed: a public key from a source the server can't swap. */
export interface TrustedSigner {
  readonly publicKey: Uint8Array;
  /** The signer's account ID, when known; then it must match too. */
  readonly accountId?: string;
}

/**
 * The signed `edited`, `approved`, `check_applied` or `agent_edited` event that made `version` of
 * a note.
 */
export function findVersionEvent(
  events: Iterable<NoteEvent>,
  noteId: string,
  version: number,
): NoteEvent | undefined {
  for (const event of events) {
    const fields = event.signed?.envelope;
    if (event.noteId !== noteId || fields === undefined) continue;
    if (isVersionWrite(fields.type) && "version" in fields && fields.version === version) {
      return event;
    }
  }
  return undefined;
}

/** The signed `deleted` event for a note's delete marker at `version`, among `events`. */
export function findDeleteEvent(
  events: Iterable<NoteEvent>,
  noteId: string,
  version: number,
): NoteEvent | undefined {
  for (const event of events) {
    const fields = event.signed?.envelope;
    if (fields?.type === "deleted" && fields.noteId === noteId && fields.version === version) {
      return event;
    }
  }
  return undefined;
}

/** The envelope types that make a note version (a delete marker aside). */
export type VersionWriteType = "edited" | "approved" | "check_applied" | "agent_edited";

/**
 * Whether an envelope type makes a note version (a delete marker aside): a person's `edited`,
 * `approved` or `check_applied`, or an agent's direct write (`agent_edited`, under its own key).
 */
export function isVersionWrite(type: string): type is VersionWriteType {
  return (
    type === "edited" || type === "approved" || type === "check_applied" || type === "agent_edited"
  );
}

function withAccount<T extends object>(fields: T, signer: TrustedSigner): T {
  return signer.accountId === undefined ? fields : { ...fields, accountId: signer.accountId };
}

/**
 * Requires signed version metadata: accepts `ciphertext` as `version` of the note only with a
 * person's signed `edited`, `approved` or `check_applied` envelope, or an agent's `agent_edited`
 * under a key in `agentKeys` (owner-vouched, `verifyAgentKey`), for this note, version and folder
 * over exactly these bytes, recorded on an event row for the same note and version (and with no
 * ciphertext of its own). Returns the verified event; throws `missing_signature` or
 * `untrusted_signature`.
 */
export function verifyNoteVersion(details: {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly version: number;
  readonly ciphertext: Uint8Array;
  /** The folder the note is in, when known (an edit signs it). */
  readonly folderId?: string;
  readonly event: NoteEvent | undefined;
  readonly signer: TrustedSigner;
  /** The verified keys of the agent an `agent_edited` names (none: it is refused). */
  readonly agentKeys?: readonly VerifiedAgentKey[];
}): NoteEvent {
  const { event } = details;
  const signed = event?.signed;
  if (event === undefined || signed == null) {
    throw new VaultError("missing_signature", "the note version is not signed");
  }
  const common = {
    workspaceId: details.workspaceId,
    noteId: details.noteId,
    version: details.version,
    ciphertextSha256: ciphertextSha256(details.ciphertext),
    ...(details.folderId === undefined ? {} : { folderId: details.folderId }),
  };
  const type = isVersionWrite(signed.envelope.type) ? signed.envelope.type : "edited";
  const rowMatches =
    event.noteId === details.noteId &&
    event.noteVersion === details.version &&
    event.ciphertext === null;
  const ok =
    rowMatches &&
    (type === "agent_edited"
      ? (details.agentKeys ?? []).some(
          (key) => checkAgentEdited(signed, key, withAccount(common, details.signer)).ok,
        )
      : verifyEnvelopeFor(
          toSignedEnvelope(signed),
          details.signer.publicKey,
          withAccount({ type, ...common } as const, details.signer),
        ));
  if (!ok) throw new VaultError("untrusted_signature", "the note version's signature is not valid");
  return event;
}

/**
 * An agent's direct write, as a verified version carries it: the agent's token, when it signed,
 * the policy revision and hash it named, and whether the agent has been revoked since.
 */
export interface AgentWrite {
  readonly tokenId: string;
  /** The `agent_edited` envelope's `createdAt`. */
  readonly at: string;
  /** The agent policy revision the agent checked before writing. */
  readonly revision: number;
  readonly policySha256: string;
  /**
   * The agent was revoked since (its versions from before stay valid; one signed after a known
   * signed revocation is refused).
   */
  readonly revoked: boolean;
}

/** The agent's write in a verified version's event (null for any other envelope). */
export function agentWriteOf(event: NoteEvent | undefined, revoked: boolean): AgentWrite | null {
  const fields = event?.signed?.envelope;
  if (fields?.type !== "agent_edited") return null;
  return {
    tokenId: fields.tokenId,
    at: fields.createdAt,
    revision: fields.revision,
    policySha256: fields.policySha256,
    revoked,
  };
}

/**
 * Requires a person's signed `deleted` envelope for a note's delete marker at `version`; returns
 * the verified event.
 */
export function verifyNoteDeletion(details: {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly version: number;
  readonly event: NoteEvent | undefined;
  readonly signer: TrustedSigner;
}): NoteEvent {
  const { event } = details;
  const signed = event?.signed;
  if (event === undefined || signed == null) {
    throw new VaultError("missing_signature", "the delete is not signed");
  }
  const expected = {
    type: "deleted" as const,
    workspaceId: details.workspaceId,
    noteId: details.noteId,
    version: details.version,
  };
  const rowMatches =
    event.noteId === details.noteId &&
    event.noteVersion === details.version &&
    event.ciphertext === null;
  const ok =
    rowMatches &&
    verifyEnvelopeFor(
      toSignedEnvelope(signed),
      details.signer.publicKey,
      withAccount(expected, details.signer),
    );
  if (!ok) throw new VaultError("untrusted_signature", "the delete's signature is not valid");
  return event;
}

/**
 * The `verifySignature` for `resolveAgentPolicyView` (knowtarium/protocol): true only for an
 * `agent_policy` signed by `ownerSigningPublicKey` (from a source the server can't swap: the
 * account's own keys, or the key the CLI pinned at connect) for `ownerAccountId`.
 */
export function agentPolicySignatureVerifier(
  ownerSigningPublicKey: Uint8Array,
  ownerAccountId: string,
): (signed: SignedAgentPolicy) => boolean {
  return (signed) =>
    signed.envelope.accountId === ownerAccountId &&
    verifyEnvelopeFor(toSignedEnvelope(signed), ownerSigningPublicKey, {
      type: "agent_policy",
      accountId: ownerAccountId,
    });
}
