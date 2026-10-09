import { z } from "zod";

import { Ciphertext } from "./ciphertext.js";
import { ActorId, CommentId, NoteId, TokenId, WorkspaceId } from "./ids.js";
import { QueryVersion, Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";
import { hasBothOrNeither, SignedEvent, signingFields } from "./signatures.js";

/*
 * A comment is one encrypted record (author, anchor, parent, status and text all inside the
 * ciphertext), stored as a small row in the workspace's Durable Object. A person's comment is
 * signed (`commented`, or `rejected` for the comment a rejection leaves; see signatures.ts).
 */

export const NoteComment = z.object({
  id: CommentId,
  workspaceId: WorkspaceId,
  noteId: NoteId,
  authorId: ActorId,
  /**
   * The agent token whose bearer secret posted it; null for a person's (session) comment, as the server saw it on the request.
   * Server-asserted attribution for display (the web binds an agent's actor name to its token),
   * not proof: nothing signs it, so a server could misattribute.
   */
  authorTokenId: TokenId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Starts at 1 and goes up with every update (for example a resolve). */
  revision: z.int().positive(),
  /** The workspace version at the last write. */
  seq: Version,
  ciphertext: Ciphertext,
  /** The envelope and signature of the last write, when a person made it. */
  signed: SignedEvent.nullable(),
});
export type NoteComment = z.infer<typeof NoteComment>;

/** A new comment. A person (session) must sign it (`commented`); an agent sends neither field. */
export const NewComment = z
  .strictObject({ id: CommentId, noteId: NoteId, ciphertext: Ciphertext, ...signingFields })
  .refine(hasBothOrNeither, { error: "Send both signedAt and signature, or neither" });
export type NewComment = z.infer<typeof NewComment>;

/** Replaces the ciphertext if `baseRevision` is current (409 with the current revision if not). */
export const UpdateCommentRequest = z
  .strictObject({ baseRevision: z.int().positive(), ciphertext: Ciphertext, ...signingFields })
  .refine(hasBothOrNeither, { error: "Send both signedAt and signature, or neither" });
export type UpdateCommentRequest = z.infer<typeof UpdateCommentRequest>;

export const COMMENTS_PAGE_MAX = 1000;

/**
 * Comments come ordered by `seq` (the workspace version of each one's last write). When `hasMore`
 * is true, ask again with `since` set to the last comment's `seq`.
 */
export const ListCommentsQuery = z.strictObject({
  noteId: NoteId.optional(),
  /** Only comments written after this workspace version. */
  since: QueryVersion.optional(),
  limit: z.coerce.number().int().min(1).max(COMMENTS_PAGE_MAX).optional(),
});
export type ListCommentsQuery = z.infer<typeof ListCommentsQuery>;

/** A retry of `addComment` with the same ID and body answers the stored comment, at its `seq`. */
export const CommentResponse = z.object({ comment: NoteComment });
export type CommentResponse = z.infer<typeof CommentResponse>;

export const ListCommentsResponse = z.object({
  comments: z.array(NoteComment),
  workspaceVersion: Version,
  /** True when the page is full: ask again with `since` set to the last comment's `seq`. */
  hasMore: z.boolean(),
});
export type ListCommentsResponse = z.infer<typeof ListCommentsResponse>;

export const commentRoutes = {
  listComments: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/comments",
    auth: "any",
    summary: "Encrypted comments, for one note or the whole scope",
    query: ListCommentsQuery,
    response: ListCommentsResponse,
  }),
  addComment: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/comments",
    auth: "any",
    summary: "Add an encrypted comment (signed when a person posts it)",
    body: NewComment,
    response: CommentResponse,
    status: 201,
  }),
  updateComment: defineRoute({
    method: "PATCH",
    path: "/workspaces/:workspaceId/comments/:commentId",
    auth: "any",
    summary: "Replace a comment's ciphertext (reply status, resolve); agents only their own",
    body: UpdateCommentRequest,
    response: CommentResponse,
  }),
};
