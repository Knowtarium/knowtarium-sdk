import { z } from "zod";

import { EncName } from "./ciphertext.js";
import { FolderId, WorkspaceId } from "./ids.js";
import { Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";
import { hasBothOrNeither, requiredSigningFields, signingFields } from "./signatures.js";

/**
 * A folder: the server sees its ID and parent (to enforce folder scopes by ID), never its name.
 * `parentId` null means the workspace root.
 */
export const Folder = z.object({
  id: FolderId,
  workspaceId: WorkspaceId,
  parentId: FolderId.nullable(),
  encName: EncName,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Folder = z.infer<typeof Folder>;

/** Signed as `folder_created`. */
export const CreateFolderRequest = z.strictObject({
  id: FolderId,
  parentId: FolderId.nullable(),
  encName: EncName,
  ...requiredSigningFields,
});
export type CreateFolderRequest = z.infer<typeof CreateFolderRequest>;

/**
 * Rename (`encName`), move (`parentId`), or both. A move is signed as `folder_moved` and must
 * carry the signing fields; a rename alone carries none.
 */
export const UpdateFolderRequest = z
  .strictObject({
    encName: EncName.optional(),
    parentId: FolderId.nullable().optional(),
    ...signingFields,
  })
  .refine((value) => value.encName !== undefined || value.parentId !== undefined, {
    error: "Nothing to update",
  })
  .refine(hasBothOrNeither, { error: "Send both signedAt and signature, or neither" })
  .refine((value) => (value.parentId !== undefined) === (value.signature !== undefined), {
    error: "A move must be signed, and only a move",
  });
export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequest>;

export const FolderResponse = z.object({ folder: Folder, workspaceVersion: Version });
export type FolderResponse = z.infer<typeof FolderResponse>;

export const ListFoldersResponse = z.object({ folders: z.array(Folder) });
export type ListFoldersResponse = z.infer<typeof ListFoldersResponse>;

export const WorkspaceVersionResponse = z.object({ workspaceVersion: Version });
export type WorkspaceVersionResponse = z.infer<typeof WorkspaceVersionResponse>;

export const folderRoutes = {
  listFolders: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/folders",
    auth: "any",
    summary: "The folder tree (for an agent, only the folders in its scope)",
    response: ListFoldersResponse,
  }),
  createFolder: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/folders",
    auth: "session",
    summary: "Create a folder with its encrypted name (signed)",
    body: CreateFolderRequest,
    response: FolderResponse,
    status: 201,
  }),
  updateFolder: defineRoute({
    method: "PATCH",
    path: "/workspaces/:workspaceId/folders/:folderId",
    auth: "session",
    summary: "Rename or move a folder (a move is signed)",
    body: UpdateFolderRequest,
    response: FolderResponse,
  }),
  deleteFolder: defineRoute({
    method: "DELETE",
    path: "/workspaces/:workspaceId/folders/:folderId",
    auth: "session",
    summary: "Delete an empty folder",
    response: WorkspaceVersionResponse,
  }),
};
