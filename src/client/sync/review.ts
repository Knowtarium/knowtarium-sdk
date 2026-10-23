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
import { conflictResult, deleteNote, type NoteWrite } from "./writes.js";

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
  const { pending } = data;
  if (pending.kind === "delete") {
    // a delete proposal has no blob: what it would delete is its base version
    // the base version in its own folder, from its signed envelope
    const base = await readNoteVersion(context, {
      noteId: pending.noteId,
      version: pending.baseVersion,
    });
    return { pending, kind: "delete", proposed: "", proposedName: null, base: snapshotOf(base) };
  }
  const { data: blob } = await context.api.call(routes.getPendingBlob, { params });
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
      : // in its own folder, from its signed envelope: a move proposal's folder is the
        // destination, where the base version never was
        await readNoteVersion(context, {
          noteId: pending.noteId,
          version: pending.baseVersion,
        });
  return {
    pending,
    kind: "edit",
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
  // a delete proposal is approved with the person's own signed delete (`approveDelete`)
  if (pending.kind === "delete") {
    throw new RequestValidationError("approvePending", "params", ["pendingId"]);
  }
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
 * Approves an agent's delete proposal (protocol 3, session): the person's own signed `deleted` of
 * the note at the proposal's base version, naming the proposal (`Knowtarium-Pending-Id`), which
 * the server closes as approved with the delete. If the note moved past that version, returns
 * both sides as a conflict instead, and nothing is deleted.
 */
export async function approveDelete(
  context: SyncContext,
  pending: PendingChange,
  options: { readonly signedAt?: string } = {},
): Promise<ApproveResult> {
  requireIdentity(context, "deleteNote");
  if (pending.kind !== "delete") {
    throw new RequestValidationError("deleteNote", "headers", ["knowtarium-pending-id"]);
  }
  const result = await deleteNote(context, {
    noteId: pending.noteId,
    baseVersion: pending.baseVersion,
    pendingId: pending.id,
    ...(options.signedAt === undefined ? {} : { signedAt: options.signedAt }),
  });
  if (result.status !== "saved") return result;
  const { data } = await context.api.call(routes.getPending, {
    params: { workspaceId: context.workspaceId, pendingId: pending.id },
  });
  return {
    status: "approved",
    pending: data.pending,
    note: result.note,
    workspaceVersion: result.workspaceVersion,
  };
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
