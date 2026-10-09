import { z } from "zod";

import { Ciphertext } from "./ciphertext.js";
import { NoteComment } from "./comments.js";
import { NoteEvent } from "./events.js";
import { CommentId, FolderId, NoteId, PendingId, TokenId, WorkspaceId } from "./ids.js";
import { NoteMeta, NoteUploadHeaders, NoteVersionHeaders } from "./notes.js";
import {
  Base64Url,
  base64UrlLength,
  QueryVersion,
  SizeBytes,
  Timestamp,
  Version,
} from "./primitives.js";
import { defineRoute, RAW_BYTES } from "./route.js";
import { headerKey, PENDING_NONCE_HEADER } from "./headers.js";
import { requiredSigningFields, SigningHeaders } from "./signatures.js";

/*
 * An agent never writes a version: it submits the complete proposed note (raw ciphertext) with its
 * base version, and a person approves or rejects it in the web app. Approving is one request: the
 * NEW ciphertext (the proposal plus the person's `verified` entry, encrypted again in the browser)
 * with the signature of an `approved` envelope in headers. The server verifies the signature,
 * stores the ciphertext as the next version only if the note is still at the pending change's
 * base version (409 with the current version if not), and records the signed event, all at once.
 */

/** The agent's random nonce for one proposal: 16 bytes, base64url. */
export const PendingNonce = Base64Url.length(base64UrlLength(16));
export type PendingNonce = z.infer<typeof PendingNonce>;

/** Headers of a pending change upload: the upload headers plus the agent's nonce. */
export const PendingUploadHeaders = NoteUploadHeaders.extend({
  [headerKey(PENDING_NONCE_HEADER)]: PendingNonce,
});
export type PendingUploadHeaders = z.infer<typeof PendingUploadHeaders>;

export const PendingStatus = z.enum(["open", "approved", "rejected"]);
export type PendingStatus = z.infer<typeof PendingStatus>;

export const PendingChange = z.object({
  id: PendingId,
  workspaceId: WorkspaceId,
  noteId: NoteId,
  folderId: FolderId,
  /** 0 proposes a new note. */
  baseVersion: Version,
  /** The agent's nonce, bound into the proposal's encryption context with the base and folder. */
  clientNonce: PendingNonce,
  sizeBytes: SizeBytes,
  submittedBy: TokenId,
  /**
   * The agent token whose bearer secret posted it (only agents propose, so it equals `submittedBy`), as the server saw it on the request.
   * Server-asserted attribution for display (the web binds an agent's actor name to its token),
   * not proof: nothing signs it, so a server could misattribute.
   */
  authorTokenId: TokenId,
  createdAt: Timestamp,
  status: PendingStatus,
  decidedAt: Timestamp.nullable(),
  /** The note version an approval produced. */
  resultingVersion: z.int().positive().nullable(),
  /** The comment a rejection left (every rejection leaves one). */
  rejectionCommentId: CommentId.nullable(),
  /** The workspace version of its last change (submitted, approved, rejected): the paging cursor. */
  seq: Version,
});
export type PendingChange = z.infer<typeof PendingChange>;

export const PendingResponse = z.object({ pending: PendingChange });
export type PendingResponse = z.infer<typeof PendingResponse>;

/** The most pending changes one `listPending` page holds. */
export const PENDING_PAGE_MAX = 1000;

/**
 * Pending changes come ordered by `seq` (the workspace version of each one's last change). When
 * `hasMore` is true, ask again with `since` set to the last change's `seq`.
 */
export const ListPendingQuery = z.strictObject({
  status: PendingStatus.optional(),
  noteId: NoteId.optional(),
  /** One agent's changes (`my_pending_changes`). */
  submittedBy: TokenId.optional(),
  /** Only changes whose last change came after this workspace version. */
  since: QueryVersion.optional(),
  limit: z.coerce.number().int().min(1).max(PENDING_PAGE_MAX).optional(),
});
export type ListPendingQuery = z.infer<typeof ListPendingQuery>;

export const ListPendingResponse = z.object({
  pending: z.array(PendingChange),
  workspaceVersion: Version,
  /** True when the page is full: ask again with `since` set to the last change's `seq`. */
  hasMore: z.boolean(),
});
export type ListPendingResponse = z.infer<typeof ListPendingResponse>;

export const ApprovePendingResponse = z.object({
  pending: PendingChange,
  note: NoteMeta,
  /** The signed `approved` event. */
  event: NoteEvent,
  workspaceVersion: Version,
});
export type ApprovePendingResponse = z.infer<typeof ApprovePendingResponse>;

/**
 * A rejection always leaves an encrypted comment for the agent to read. The signature covers a
 * `rejected` envelope naming the pending change and the comment, with the comment's hash.
 */
export const RejectPendingRequest = z.strictObject({
  commentId: CommentId,
  ciphertext: Ciphertext,
  ...requiredSigningFields,
});
export type RejectPendingRequest = z.infer<typeof RejectPendingRequest>;

export const RejectPendingResponse = z.object({
  pending: PendingChange,
  comment: NoteComment,
  /** The signed `rejected` event. */
  event: NoteEvent,
});
export type RejectPendingResponse = z.infer<typeof RejectPendingResponse>;

export const pendingRoutes = {
  submitPending: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/notes/:noteId/pending-changes",
    auth: "agent",
    summary: "An agent proposes a new version (raw ciphertext) with its base version",
    headers: PendingUploadHeaders,
    body: RAW_BYTES,
    response: PendingResponse,
    status: 201,
  }),
  listPending: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/pending-changes",
    auth: "any",
    summary: "Pending changes, filtered by status, note or submitting token",
    query: ListPendingQuery,
    response: ListPendingResponse,
  }),
  getPending: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/pending-changes/:pendingId",
    auth: "any",
    summary: "One pending change's metadata",
    response: PendingResponse,
  }),
  getPendingBlob: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/pending-changes/:pendingId/blob",
    auth: "any",
    summary: "The proposed ciphertext (raw bytes)",
    response: RAW_BYTES,
  }),
  approvePending: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/pending-changes/:pendingId/approval",
    auth: "session",
    summary: "Store the approved note (new raw ciphertext, signed) as the next version",
    headers: SigningHeaders,
    body: RAW_BYTES,
    responseHeaders: NoteVersionHeaders,
    response: ApprovePendingResponse,
  }),
  rejectPending: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/pending-changes/:pendingId/rejection",
    auth: "session",
    summary: "Close a pending change as rejected, with a signed encrypted comment",
    body: RejectPendingRequest,
    response: RejectPendingResponse,
  }),
};
