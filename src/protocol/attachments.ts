import { z } from "zod";

import { EncAttachmentMeta, LIMITS } from "./ciphertext.js";
import { ActorId, AttachmentId, FolderId, WorkspaceId } from "./ids.js";
import { SizeBytes, Timestamp } from "./primitives.js";
import { defineRoute, RAW_BYTES } from "./route.js";
import { WorkspaceVersionResponse } from "./folders.js";

/*
 * Attachments are encrypted in chunks (each chunk its own envelope) and uploaded chunk by chunk as
 * raw bytes. Their metadata travels encrypted too (`encMeta`: the JSON `{ name, type, sizeBytes }`,
 * blob kind `attachment_meta`): the file name within its folder (normalized like a note's file
 * name, never `.md`, unique in the folder with letter case ignored, which clients check since the
 * server can't read it), the media type and the plaintext size. Notes link them by path; the
 * folder is plaintext so the server can check scopes.
 */

export const AttachmentStatus = z.enum(["uploading", "complete"]);
export type AttachmentStatus = z.infer<typeof AttachmentStatus>;

export const Attachment = z.object({
  id: AttachmentId,
  workspaceId: WorkspaceId,
  folderId: FolderId,
  /** The encrypted metadata: file name, media type and plaintext size. */
  encMeta: EncAttachmentMeta,
  /** Total ciphertext size of all chunks. */
  sizeBytes: SizeBytes,
  chunkCount: z.int().positive(),
  chunksReceived: z.int().nonnegative(),
  status: AttachmentStatus,
  authorId: ActorId,
  createdAt: Timestamp,
});
export type Attachment = z.infer<typeof Attachment>;

/** Marks an upload complete, once every chunk is stored. */
export const UpdateAttachmentRequest = z.strictObject({ status: z.literal("complete") });
export type UpdateAttachmentRequest = z.infer<typeof UpdateAttachmentRequest>;

/** Announces an upload, so the quota is checked before any bytes are stored. */
export const CreateAttachmentRequest = z.strictObject({
  id: AttachmentId,
  folderId: FolderId,
  /** The encrypted metadata (`{ name, type, sizeBytes }`). */
  encMeta: EncAttachmentMeta,
  sizeBytes: SizeBytes.max(LIMITS.attachmentBytes),
  chunkCount: z.int().positive(),
});
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequest>;

export const AttachmentResponse = z.object({ attachment: Attachment });
export type AttachmentResponse = z.infer<typeof AttachmentResponse>;

export const attachmentRoutes = {
  createAttachment: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/attachments",
    auth: "any",
    summary: "Start a chunked upload; the quota is checked here",
    body: CreateAttachmentRequest,
    response: AttachmentResponse,
    status: 201,
  }),
  uploadAttachmentChunk: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/attachments/:attachmentId/chunks/:chunkIndex",
    auth: "any",
    summary: "Store one encrypted chunk (raw bytes)",
    body: RAW_BYTES,
    response: AttachmentResponse,
  }),
  completeAttachment: defineRoute({
    method: "PATCH",
    path: "/workspaces/:workspaceId/attachments/:attachmentId",
    auth: "any",
    summary: "Finish an upload once every chunk is stored",
    body: UpdateAttachmentRequest,
    response: AttachmentResponse,
  }),
  getAttachment: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/attachments/:attachmentId",
    auth: "any",
    summary: "An attachment's metadata",
    response: AttachmentResponse,
  }),
  getAttachmentChunk: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/attachments/:attachmentId/chunks/:chunkIndex",
    auth: "any",
    summary: "One encrypted chunk (raw bytes)",
    response: RAW_BYTES,
  }),
  deleteAttachment: defineRoute({
    method: "DELETE",
    path: "/workspaces/:workspaceId/attachments/:attachmentId",
    auth: "session",
    summary: "Delete an attachment and its chunks",
    response: WorkspaceVersionResponse,
  }),
};
