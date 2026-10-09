import type { CommentEntry, CommentRecord } from "../../core/history/index.js";
import type { NoteId } from "../../protocol/index.js";
import { routes } from "../../protocol/index.js";
import { newId } from "../platform/ids.js";
import { type SyncContext, withCurrentKey } from "../sync/context.js";
import { encryptComment, signCommented, signingFields } from "../vault/index.js";
import { readCommentEntry } from "./load.js";

/** The signing fields for a comment write: a person signs (`commented`), an agent doesn't. */
function commentSigning(
  context: SyncContext,
  details: {
    noteId: NoteId;
    commentId: string;
    baseRevision: number | null;
    bytes: Uint8Array;
    signedAt?: string | undefined;
  },
): { signedAt?: string; signature?: string } {
  if (context.api.auth.kind !== "session" || context.identity === undefined) return {};
  return signingFields(
    signCommented(context.identity, {
      workspaceId: context.workspaceId,
      noteId: details.noteId,
      commentId: details.commentId,
      baseRevision: details.baseRevision,
      ciphertext: details.bytes,
      ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
    }),
  );
}

/**
 * Adds an encrypted comment (or a reply: a record with `parent`) to a note. A person's comment
 * is signed (at `options.signedAt`, see `SigningTime`, or now); an agent's isn't. Returns it as the timeline shows it.
 */
export function addComment(
  context: SyncContext,
  noteId: NoteId,
  record: CommentRecord,
  options: { readonly signedAt?: string } = {},
): Promise<CommentEntry> {
  const { workspaceId } = context;
  return withCurrentKey(context, async (keys) => {
    const id = newId("cmt");
    const sealed = encryptComment(keys.current, { workspaceId, id }, record);
    const signing = commentSigning(context, {
      noteId,
      commentId: id,
      baseRevision: null,
      bytes: sealed.bytes,
      signedAt: options.signedAt,
    });
    const { data } = await context.api.call(routes.addComment, {
      params: { workspaceId },
      body: { id, noteId, ciphertext: sealed.ciphertext, ...signing },
      idempotent: true,
    });
    return readCommentEntry(context, data.comment);
  });
}

/**
 * Replaces a comment's record (a resolve, an edit) as its next revision, if `comment.revision`
 * is still current; a 409 `conflict` means someone changed it first, so read it again.
 */
export function updateComment(
  context: SyncContext,
  comment: Pick<CommentEntry, "id" | "noteId" | "revision">,
  record: CommentRecord,
  options: { readonly signedAt?: string } = {},
): Promise<CommentEntry> {
  const { workspaceId } = context;
  return withCurrentKey(context, async (keys) => {
    const sealed = encryptComment(keys.current, { workspaceId, id: comment.id }, record);
    const signing = commentSigning(context, {
      noteId: comment.noteId as NoteId,
      commentId: comment.id,
      baseRevision: comment.revision,
      bytes: sealed.bytes,
      signedAt: options.signedAt,
    });
    const { data } = await context.api.call(routes.updateComment, {
      params: { workspaceId, commentId: comment.id },
      body: { baseRevision: comment.revision, ciphertext: sealed.ciphertext, ...signing },
    });
    return readCommentEntry(context, data.comment);
  });
}
