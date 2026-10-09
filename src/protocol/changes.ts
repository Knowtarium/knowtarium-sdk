import { z } from "zod";

import { EncAttachmentMeta, EncName } from "./ciphertext.js";
import {
  ActorId,
  AttachmentId,
  CheckId,
  CommentId,
  EventId,
  FolderId,
  NoteId,
  PendingId,
} from "./ids.js";
import { CheckStatus } from "./checks.js";
import { PendingStatus } from "./pending.js";
import { KeyGeneration, QueryVersion, SizeBytes, Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";

/*
 * The changes feed: every write in a workspace bumps its version, and `?since=v` returns one entry
 * per object changed after v, with its latest state, ordered by `seq` (the workspace version of
 * that change). A client keeps the highest `seq` it has seen and asks again from there. For an
 * agent token the feed holds only objects inside its scope.
 */

const entry = { seq: Version, at: Timestamp };

export const ChangeEntry = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    ...entry,
    encName: EncName,
    keyGeneration: KeyGeneration,
    /**
     * The agent policy's current revision (protocol 2; absent from older servers and while the
     * workspace has none). A change means: fetch it again (`getAgentPolicy`).
     */
    agentPolicyRevision: Version.optional(),
  }),
  z.object({
    kind: z.literal("folder"),
    ...entry,
    folderId: FolderId,
    parentId: FolderId.nullable(),
    encName: EncName,
    deleted: z.boolean(),
    /** When the folder was created (orders folders with the same name). */
    createdAt: Timestamp,
  }),
  z.object({
    kind: z.literal("note"),
    ...entry,
    noteId: NoteId,
    folderId: FolderId,
    version: Version,
    sizeBytes: SizeBytes,
    authorId: ActorId,
    deleted: z.boolean(),
    /**
     * When version 1 was stored: the note that was there first keeps a contested file name
     * (see `buildWorkspacePaths` in knowtarium/core).
     */
    createdAt: Timestamp,
  }),
  z.object({
    kind: z.literal("pending"),
    ...entry,
    pendingId: PendingId,
    noteId: NoteId,
    status: PendingStatus,
  }),
  z.object({ kind: z.literal("event"), ...entry, eventId: EventId, noteId: NoteId }),
  z.object({ kind: z.literal("comment"), ...entry, commentId: CommentId, noteId: NoteId }),
  z.object({
    kind: z.literal("check"),
    ...entry,
    checkId: CheckId,
    noteId: NoteId,
    status: CheckStatus,
  }),
  z.object({
    kind: z.literal("attachment"),
    ...entry,
    attachmentId: AttachmentId,
    folderId: FolderId,
    /** The encrypted metadata; null only for a deleted attachment whose metadata is gone. */
    encMeta: EncAttachmentMeta.nullable(),
    deleted: z.boolean(),
    /** When the attachment was created: of two with the same name, clients keep the oldest. */
    createdAt: Timestamp,
  }),
]);
export type ChangeEntry = z.infer<typeof ChangeEntry>;
export type ChangeKind = ChangeEntry["kind"];

export const CHANGES_PAGE_MAX = 1000;

export const ChangesQuery = z.strictObject({
  since: QueryVersion,
  limit: z.coerce.number().int().min(1).max(CHANGES_PAGE_MAX).optional(),
});
export type ChangesQuery = z.infer<typeof ChangesQuery>;

export const ChangesResponse = z.object({
  /** The workspace's current version. */
  workspaceVersion: Version,
  changes: z.array(ChangeEntry),
  /** True when the page is full: ask again with `since` set to the last entry's `seq`. */
  hasMore: z.boolean(),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

export const changeRoutes = {
  listChanges: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/changes",
    auth: "any",
    summary: "What changed since a workspace version",
    query: ChangesQuery,
    response: ChangesResponse,
  }),
};
