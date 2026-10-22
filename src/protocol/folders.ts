import { z } from "zod";

import { EncName } from "./ciphertext.js";
import { AGENT_POLICY_REVISION_HEADER, AGENT_SCOPE_REVISION_HEADER, headerKey } from "./headers.js";
import { ActorId, FolderId, TokenId, WorkspaceId } from "./ids.js";
import { AgentPolicyRevisionHeader, AgentScopeRevisionHeader } from "./notes.js";
import { QueryVersion, Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";
import {
  hasBothOrNeither,
  requiredSigningFields,
  SignedEvent,
  SigningHeaders,
  signingFields,
} from "./signatures.js";

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

/**
 * Signed as `folder_created`. The ID of a deleted folder revives it (protocol 3), under its own ID
 * and only where it was: `parentId` must be its stored parent (another answers 400
 * `invalid_request`: move it afterwards), which must be live unless it was at the top level. It keeps `createdAt`, takes the name sent and records `restored` in the folder
 * history. A live folder with that ID still answers `already_exists`.
 */
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

/**
 * What every agent folder change carries besides its own fields (protocol 3): the agent policy
 * revision it checked, the scope revision it acted under, and its own signature.
 */
const agentFolderFields = {
  /** The agent policy revision the agent checked (0: no policy yet). */
  policyRevision: Version,
  /** The scope revision the agent acted under. */
  scopeRevision: z.int().positive(),
  ...requiredSigningFields,
};

/**
 * An agent with `folders.create` creates a folder (or revives a deleted one where it was), signed
 * `agent_folder_created` with its own key. `parentId` null (the top level) only for a
 * whole-workspace token.
 *
 * The agent folder routes refuse, in this order: the token (401) and workspace (404); 403
 * `scope_denied` (not `read-write`, or a folder the action touches outside the write scope: the
 * folder, its parent and for a move the new parent; for a revive, the deleted folder's own
 * stored place); 403 `permission_required`; 404 `not_found` (the folder; a live folder with a
 * create's ID answers `already_exists` unless it is the same create retried, and a revive under
 * another parent `invalid_request`); 403 `protected_folder` (a folder in any connected agent's
 * scope list, the workspace root folder, and for a delete the clipper's inbox); 403
 * `agent_key_required`; 409 `stale_agent_policy`; 409 `stale_agent_scope`; 400
 * `invalid_signature`; 403 `approval_required` (the folder or a folder whose contents change asks
 * first: folder changes there are refused, never proposed); the tree's own refusals as for
 * people (a missing parent, a cycle, too deep, 409 `not_empty`); 429 `rate_limited` (200 folder
 * changes per token a day); 402 `quota_exceeded`.
 */
export const CreateFolderAsAgentRequest = z.strictObject({
  id: FolderId,
  parentId: FolderId.nullable(),
  encName: EncName,
  ...agentFolderFields,
});
export type CreateFolderAsAgentRequest = z.infer<typeof CreateFolderAsAgentRequest>;

/** An agent with `folders.rename` renames a folder, signed `agent_folder_renamed`. */
export const RenameFolderAsAgentRequest = z.strictObject({
  encName: EncName,
  ...agentFolderFields,
});
export type RenameFolderAsAgentRequest = z.infer<typeof RenameFolderAsAgentRequest>;

/**
 * An agent with `folders.move` moves a folder (with everything in it) under `parentId` (null: the
 * top level, only for a whole-workspace token), signed `agent_folder_moved`.
 */
export const MoveFolderAsAgentRequest = z.strictObject({
  parentId: FolderId.nullable(),
  ...agentFolderFields,
});
export type MoveFolderAsAgentRequest = z.infer<typeof MoveFolderAsAgentRequest>;

/**
 * Headers of an agent's folder delete (`folders.delete`, an empty folder only): its signature on
 * `agent_folder_deleted` and both revisions.
 */
export const AgentFolderDeleteHeaders = SigningHeaders.extend({
  [headerKey(AGENT_POLICY_REVISION_HEADER)]: AgentPolicyRevisionHeader,
  [headerKey(AGENT_SCOPE_REVISION_HEADER)]: AgentScopeRevisionHeader,
});
export type AgentFolderDeleteHeaders = z.infer<typeof AgentFolderDeleteHeaders>;

/** What happened to a folder in one folder event. */
export const FolderEventAction = z.enum(["created", "renamed", "moved", "deleted", "restored"]);
export type FolderEventAction = z.infer<typeof FolderEventAction>;

/**
 * One change of a folder (protocol 3), people's and agents' alike, kept as long as note history:
 * who made it, when, and the parent and encrypted name before and after (null where it didn't
 * apply: no name before a create, no parent at the top level). `signed` is the change's envelope
 * (`folder_created`, `folder_moved`, or an agent's `agent_folder_*`), verified by clients; null
 * for a person's rename or delete, which are unsigned (the server's word).
 */
export const FolderEvent = z.object({
  /** The workspace version of the change: the paging cursor. */
  seq: Version,
  folderId: FolderId,
  action: FolderEventAction,
  authorId: ActorId,
  /** The agent token that made it; null for a person's change. */
  authorTokenId: TokenId.nullable(),
  createdAt: Timestamp,
  parentBefore: FolderId.nullable(),
  parentAfter: FolderId.nullable(),
  encNameBefore: EncName.nullable(),
  encNameAfter: EncName.nullable(),
  signed: SignedEvent.nullable(),
});
export type FolderEvent = z.infer<typeof FolderEvent>;

/** The most folder events one `listFolderEvents` page holds. */
export const FOLDER_EVENTS_PAGE_MAX = 1000;

/**
 * Folder events ordered by `seq`, for one folder or every folder (an agent: those in its read
 * scope). When `hasMore` is true, ask again with `since` set to the last event's `seq`.
 */
export const ListFolderEventsQuery = z.strictObject({
  since: QueryVersion.optional(),
  folderId: FolderId.optional(),
  limit: z.coerce.number().int().min(1).max(FOLDER_EVENTS_PAGE_MAX).optional(),
});
export type ListFolderEventsQuery = z.infer<typeof ListFolderEventsQuery>;

export const ListFolderEventsResponse = z.object({
  events: z.array(FolderEvent),
  workspaceVersion: Version,
  /** True when the page is full: ask again with `since` set to the last event's `seq`. */
  hasMore: z.boolean(),
});
export type ListFolderEventsResponse = z.infer<typeof ListFolderEventsResponse>;

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
  createFolderAsAgent: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/agent-folders",
    auth: "agent",
    agentSigns: true,
    summary: "An agent with folders.create creates or revives a folder, signed with its own key",
    body: CreateFolderAsAgentRequest,
    response: FolderResponse,
    status: 201,
  }),
  renameFolderAsAgent: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/agent-folders/:folderId/name",
    auth: "agent",
    agentSigns: true,
    summary: "An agent with folders.rename renames a folder, signed with its own key",
    body: RenameFolderAsAgentRequest,
    response: FolderResponse,
  }),
  moveFolderAsAgent: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/agent-folders/:folderId/parent",
    auth: "agent",
    agentSigns: true,
    summary: "An agent with folders.move moves a folder, signed with its own key",
    body: MoveFolderAsAgentRequest,
    response: FolderResponse,
  }),
  deleteFolderAsAgent: defineRoute({
    method: "DELETE",
    path: "/workspaces/:workspaceId/agent-folders/:folderId",
    auth: "agent",
    agentSigns: true,
    summary: "An agent with folders.delete deletes an empty folder, signed with its own key",
    headers: AgentFolderDeleteHeaders,
    response: WorkspaceVersionResponse,
  }),
  listFolderEvents: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/folder-events",
    auth: "any",
    summary: "Folder changes with who made them and the state before (an agent: its read scope)",
    query: ListFolderEventsQuery,
    response: ListFolderEventsResponse,
  }),
};
