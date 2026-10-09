import {
  ciphertextSha256,
  fromBase64Url,
  type SignedEnvelopeFields,
  verifyEnvelopeFor,
} from "../../crypto/index.js";
import type { CommentRecord, SignatureStatus } from "../../core/history/index.js";
import type { NoteComment, NoteEvent } from "../../protocol/index.js";
import {
  checkAgentEdited,
  toSignedEnvelope,
  type TrustedSigner,
  type VerifiedAgentKey,
} from "../vault/index.js";

type Expected = Partial<SignedEnvelopeFields> & { readonly type: SignedEnvelopeFields["type"] };

function check(
  signed: NonNullable<NoteEvent["signed"]>,
  signer: TrustedSigner,
  expected: Expected,
): boolean {
  return verifyEnvelopeFor(
    toSignedEnvelope(signed),
    signer.publicKey,
    signer.accountId === undefined ? expected : { ...expected, accountId: signer.accountId },
  );
}

/**
 * Whether an event's signature verifies and names this very event. A write (`edited`,
 * `deleted`, `approved`) must be on a row for the same note and version and carry no ciphertext
 * of its own; a rejection must name the row's note and carry none either; a person's appended
 * record (`recorded`) must name the event, its note and the hash of its ciphertext. An agent's
 * direct write (`agent_edited`) is checked like a person's write, under a key in `agentKeys`
 * (the owner-vouched keys of the token it names), never the owner's.
 */
export function eventSignatureValid(
  event: NoteEvent,
  workspaceId: string,
  signer: TrustedSigner,
  agentKeys: readonly VerifiedAgentKey[] = [],
): boolean {
  const signed = event.signed;
  if (signed === null) return false;
  const fields = signed.envelope;
  const common = { workspaceId, noteId: event.noteId };
  switch (fields.type) {
    case "agent_edited": {
      const version = event.noteVersion;
      const expected = {
        ...common,
        ...(version === null ? {} : { version }),
        ...(signer.accountId === undefined ? {} : { accountId: signer.accountId }),
      };
      return (
        event.ciphertext === null &&
        version !== null &&
        agentKeys.some((key) => checkAgentEdited(signed, key, expected).ok)
      );
    }
    case "edited":
    case "deleted":
    case "approved":
    case "check_applied":
      return (
        event.ciphertext === null &&
        event.noteVersion !== null &&
        check(signed, signer, { ...common, type: fields.type, version: event.noteVersion })
      );
    case "rejected":
      return event.ciphertext === null && check(signed, signer, { ...common, type: "rejected" });
    case "recorded":
      return (
        event.ciphertext !== null &&
        check(signed, signer, {
          ...common,
          type: "recorded",
          eventId: event.id,
          ciphertextSha256: ciphertextSha256(fromBase64Url(event.ciphertext)),
        })
      );
    default:
      return false;
  }
}

/**
 * How far to trust a comment. A signed one must name this comment at this revision (as
 * `commented`, or `rejected` for the comment a rejection left) over exactly its ciphertext, on
 * this note, and a `human:` author must be the signer. The record must be anchored to the note it
 * is filed under. An unsigned comment is an agent's, unless it claims a person (`unconfirmed`).
 */
export function commentSignature(
  comment: NoteComment,
  record: CommentRecord | null,
  workspaceId: string,
  signer: TrustedSigner,
): SignatureStatus {
  if (record !== null && record.anchor.note !== comment.noteId) return "invalid";
  const signed = comment.signed;
  const author = record?.author;
  if (signed === null) {
    const claimsPerson =
      author?.startsWith("human:") === true || comment.authorId.startsWith("acc_");
    return claimsPerson ? "unconfirmed" : "unsigned";
  }
  if (author?.startsWith("human:") === true && author !== `human:${signed.envelope.accountId}`) {
    return "invalid";
  }
  const hash = ciphertextSha256(fromBase64Url(comment.ciphertext));
  const common = {
    workspaceId,
    noteId: comment.noteId,
    commentId: comment.id,
    ciphertextSha256: hash,
  };
  const ok =
    signed.envelope.type === "rejected"
      ? check(signed, signer, { ...common, type: "rejected" })
      : check(signed, signer, { ...common, type: "commented", revision: comment.revision });
  return ok ? "verified" : "invalid";
}
