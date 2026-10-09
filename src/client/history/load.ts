import {
  buildTimeline,
  type CheckEntry,
  CheckFindings,
  type CommentEntry,
  CommentRecord,
  type HistoryEventEntry,
  readHistoryEvent,
  type SignedFields,
  type Timeline,
} from "../../core/history/index.js";
import type { WorkspaceKeyring } from "../../crypto/index.js";
import type {
  CheckRecord,
  CheckStatus,
  NoteComment,
  NoteEvent,
  NoteId,
} from "../../protocol/index.js";
import { decryptCheck, decryptComment, decryptEvent } from "../vault/index.js";
import { agentKeysFor, anyRevoked } from "../sync/agent-keys.js";
import { type SyncContext, withKeys } from "../sync/context.js";
import { fetchEvents } from "../sync/notes.js";
import { fetchChecks, fetchComments, fetchVersions } from "../sync/records.js";
import { commentSignature, eventSignatureValid } from "./verify.js";

/** Decrypts with the workspace keys; null when it can't (the entry then shows as unreadable). */
async function tryDecrypt(
  context: SyncContext,
  run: (keys: WorkspaceKeyring) => unknown,
): Promise<unknown> {
  try {
    return await withKeys(context, run);
  } catch {
    return null;
  }
}

const isPerson = (authorId: string) => authorId.startsWith("acc_");

/** A stored event, decrypted, verified and typed. */
export async function readEventEntry(
  context: SyncContext,
  event: NoteEvent,
): Promise<HistoryEventEntry> {
  const { workspaceId } = context;
  const ciphertext = event.ciphertext;
  const record =
    ciphertext === null
      ? undefined
      : await tryDecrypt(context, (keys) =>
          decryptEvent(keys, { workspaceId, id: event.id }, ciphertext),
        );
  const agentKeys = await agentKeysFor(context.verifier, event);
  const signatureValid = eventSignatureValid(event, workspaceId, context.verifier.owner, agentKeys);
  const signed = (event.signed?.envelope ?? null) as SignedFields | null;
  const read = readHistoryEvent({
    signed,
    signatureValid,
    ...(record === undefined ? {} : { record }),
    authorIsPerson: isPerson(event.authorId),
  });
  const agent =
    signed?.type === "agent_edited" && signed.tokenId !== undefined && signatureValid
      ? { agent: { tokenId: signed.tokenId, revoked: anyRevoked(agentKeys) } }
      : {};
  return {
    id: event.id,
    seq: event.seq,
    createdAt: event.createdAt,
    authorId: event.authorId,
    authorTokenId: event.authorTokenId,
    noteVersion: event.noteVersion,
    ...read,
    ...agent,
  };
}

/** A stored comment, decrypted and verified. */
export async function readCommentEntry(
  context: SyncContext,
  comment: NoteComment,
): Promise<CommentEntry> {
  const { workspaceId } = context;
  const decrypted = await tryDecrypt(context, (keys) =>
    decryptComment(keys, { workspaceId, id: comment.id }, comment.ciphertext),
  );
  const parsed = CommentRecord.safeParse(decrypted);
  const record = parsed.success ? parsed.data : null;
  return {
    id: comment.id,
    noteId: comment.noteId,
    authorId: comment.authorId,
    authorTokenId: comment.authorTokenId,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    revision: comment.revision,
    seq: comment.seq,
    record,
    signature: commentSignature(comment, record, workspaceId, context.verifier.owner),
  };
}

/** A check record with the note it is about. */
export interface NoteCheckEntry extends CheckEntry {
  readonly noteId: NoteId;
}

/** A stored check record, decrypted (agents' records carry no signature). */
export async function readCheckEntry(
  context: SyncContext,
  check: CheckRecord,
): Promise<NoteCheckEntry> {
  const { workspaceId } = context;
  const decrypted = await tryDecrypt(context, (keys) =>
    decryptCheck(keys, { workspaceId, id: check.id }, check.ciphertext),
  );
  const parsed = CheckFindings.safeParse(decrypted);
  const findings = parsed.success ? parsed.data : null;
  return {
    id: check.id,
    noteId: check.noteId,
    noteVersion: check.noteVersion,
    authorId: check.authorId,
    authorTokenId: check.authorTokenId,
    createdAt: check.createdAt,
    status: check.status,
    seq: check.seq,
    findings,
    signature: findings?.actor.startsWith("human:") === true ? "unconfirmed" : "unsigned",
  };
}

/** Comments of one note or the whole scope, decrypted and verified. */
export async function loadComments(
  context: SyncContext,
  query: { readonly noteId?: NoteId } = {},
): Promise<CommentEntry[]> {
  const comments = await fetchComments(context, query);
  return Promise.all(comments.map((comment) => readCommentEntry(context, comment)));
}

/** Check records of one note or the whole scope (optionally by status), decrypted. */
export async function loadChecks(
  context: SyncContext,
  query: { readonly noteId?: NoteId; readonly status?: CheckStatus } = {},
): Promise<NoteCheckEntry[]> {
  const checks = await fetchChecks(context, query);
  return Promise.all(checks.map((check) => readCheckEntry(context, check)));
}

/**
 * A note's timeline: its versions, events, check records and comments, fetched, decrypted and
 * verified, then built by core's `buildTimeline`. Versions are shown with the signature of the
 * event that made them; their content is verified when a version is opened (`readVersion`).
 */
export async function loadTimeline(context: SyncContext, noteId: NoteId): Promise<Timeline> {
  const [versions, events, comments, checks] = await Promise.all([
    fetchVersions(context, noteId),
    fetchEvents(context, { noteId }),
    fetchComments(context, { noteId }),
    fetchChecks(context, { noteId }),
  ]);
  const checkEntries = await Promise.all(checks.map((check) => readCheckEntry(context, check)));
  return buildTimeline({
    versions,
    events: await Promise.all(events.map((event) => readEventEntry(context, event))),
    comments: await Promise.all(comments.map((comment) => readCommentEntry(context, comment))),
    checks: checkEntries,
  });
}
