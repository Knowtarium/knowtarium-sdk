import { type NoteFile, normalizeNoteName, uniqueName } from "../../core/files/index.js";
import {
  formatVersionTag,
  type PendingChange,
  type PendingId,
  routes,
} from "../../protocol/index.js";
import { isSyncApiError, RequestValidationError } from "../errors/index.js";
import { newId, newPendingNonce } from "../platform/ids.js";
import {
  decryptPendingNote,
  encryptComment,
  encryptNote,
  encryptPendingNote,
  signApproved,
  signingFields,
  signingHeaders,
  signRejected,
} from "../vault/index.js";
import { requireIdentity, type SyncContext, withCurrentKey, withKeys } from "./context.js";
import { acceptNote, checkStoredWrite, readNoteVersion, snapshotOf } from "./notes.js";
import type { ApproveResult, PendingReview, RejectResult, SubmitResult } from "./results.js";
import { conflictResult, type NoteWrite } from "./writes.js";

/**
 * An agent proposes a new version: the whole note, encrypted as a pending change, with its base
 * version. Nothing changes until a person approves it.
 */
export async function submitPending(
  context: SyncContext,
  proposal: NoteWrite,
): Promise<SubmitResult> {
  if (context.api.auth.kind !== "agent") throw new RequestValidationError("submitPending", "auth");
  const { workspaceId } = context;
  try {
    return await withCurrentKey(context, async (keys) => {
      const nonce = newPendingNonce();
      const ciphertext = encryptPendingNote(
        keys.current,
        {
          workspaceId,
          noteId: proposal.noteId,
          folderId: proposal.folderId,
          baseVersion: proposal.baseVersion,
          nonce,
        },
        { name: proposal.name, text: proposal.text },
      );
      const { data } = await context.api.call(routes.submitPending, {
        params: { workspaceId, noteId: proposal.noteId },
        headers: {
          "if-match": formatVersionTag(proposal.baseVersion),
          "knowtarium-folder-id": proposal.folderId,
          "knowtarium-pending-nonce": nonce,
        },
        body: ciphertext,
      });
      return { status: "submitted" as const, pending: data.pending };
    });
  } catch (error) {
    if (!isSyncApiError(error, "conflict")) throw error;
    return conflictResult(context, proposal.noteId, {
      baseVersion: proposal.baseVersion,
      name: proposal.name,
      text: proposal.text,
    });
  }
}

/** A pending change decrypted for review, with the verified version it was based on. */
export async function readPending(
  context: SyncContext,
  pendingId: PendingId,
): Promise<PendingReview> {
  const { workspaceId } = context;
  const params = { workspaceId, pendingId };
  const { data } = await context.api.call(routes.getPending, { params });
  const { data: blob } = await context.api.call(routes.getPendingBlob, { params });
  const { pending } = data;
  const proposed = await withKeys(context, (keys) =>
    decryptPendingNote(
      keys,
      {
        workspaceId,
        noteId: pending.noteId,
        folderId: pending.folderId,
        baseVersion: pending.baseVersion,
        nonce: pending.clientNonce,
      },
      blob,
    ),
  );
  const base =
    pending.baseVersion === 0
      ? null
      : await readNoteVersion(context, {
          noteId: pending.noteId,
          folderId: pending.folderId,
          version: pending.baseVersion,
        });
  return {
    pending,
    proposed: proposed.text,
    proposedName: proposed.name,
    base: base === null ? null : snapshotOf(base),
  };
}

/**
 * Approves a pending change in one request: `approved` (the proposal's file name, and its text
 * with the person's `verified` entry added) encrypted as the note's next version and signed
 * (`approved`). Pass `takenNames` (the other notes' names in the folder): a name taken meanwhile
 * gets `uniqueName`. If the note moved past the proposal's base version, returns both versions
 * instead.
 */
export async function approvePending(
  context: SyncContext,
  pending: PendingChange,
  proposal: NoteFile,
  options: { readonly takenNames: readonly string[]; readonly signedAt?: string },
): Promise<ApproveResult> {
  const identity = requireIdentity(context, "approvePending");
  const { workspaceId } = context;
  const approved = {
    name: uniqueName(normalizeNoteName(proposal.name), options.takenNames, pending.noteId),
    text: proposal.text,
  };
  try {
    return await withCurrentKey(context, async (keys) => {
      const ciphertext = encryptNote(
        keys.current,
        { workspaceId, noteId: pending.noteId },
        approved,
      );
      const action = signApproved(identity, {
        workspaceId,
        noteId: pending.noteId,
        pendingId: pending.id,
        folderId: pending.folderId,
        baseVersion: pending.baseVersion,
        ciphertext,
        ...(options.signedAt === undefined ? {} : { signedAt: options.signedAt }),
      });
      const { data } = await context.api.call(routes.approvePending, {
        params: { workspaceId, pendingId: pending.id },
        headers: signingHeaders(action),
        body: ciphertext,
      });
      checkStoredWrite(context, data, {
        noteId: pending.noteId,
        folderId: pending.folderId,
        baseVersion: pending.baseVersion,
        ciphertext,
      });
      const note = await acceptNote(context, {
        noteId: pending.noteId,
        folderId: data.note.folderId,
        version: data.note.currentVersion,
        name: normalizeNoteName(approved.name),
        text: approved.text,
        createdAt: data.note.createdAt,
        ciphertext,
        event: data.event,
      });
      return {
        status: "approved" as const,
        pending: data.pending,
        note,
        workspaceVersion: data.workspaceVersion,
      };
    });
  } catch (error) {
    if (!isSyncApiError(error, "conflict")) throw error;
    return conflictResult(context, pending.noteId, {
      baseVersion: pending.baseVersion,
      name: approved.name,
      text: approved.text,
    });
  }
}

/**
 * Rejects a pending change, leaving an encrypted comment for the agent (`comment` is the comment
 * record: author, anchor, status and text), signed as `rejected`.
 */
export async function rejectPending(
  context: SyncContext,
  pending: PendingChange,
  comment: unknown,
  options: { readonly signedAt?: string } = {},
): Promise<RejectResult> {
  const identity = requireIdentity(context, "rejectPending");
  const { workspaceId } = context;
  return withCurrentKey(context, async (keys) => {
    const commentId = newId("cmt");
    const sealed = encryptComment(keys.current, { workspaceId, id: commentId }, comment);
    const action = signRejected(identity, {
      workspaceId,
      noteId: pending.noteId,
      pendingId: pending.id,
      commentId,
      commentCiphertext: sealed.bytes,
      ...(options.signedAt === undefined ? {} : { signedAt: options.signedAt }),
    });
    const { data } = await context.api.call(routes.rejectPending, {
      params: { workspaceId, pendingId: pending.id },
      body: { commentId, ciphertext: sealed.ciphertext, ...signingFields(action) },
      idempotent: true,
    });
    return { pending: data.pending, comment: data.comment };
  });
}
