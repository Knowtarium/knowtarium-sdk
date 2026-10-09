import type { BlobContext } from "../../crypto/index.js";

/** A note in a workspace. */
export interface NoteRef {
  readonly workspaceId: string;
  readonly noteId: string;
}

/**
 * What a proposal is bound to: the note, the folder it goes to, the version it builds on, and the
 * agent's random nonce (sent as `Knowtarium-Pending-Nonce`, returned as `clientNonce`).
 */
export interface PendingRef extends NoteRef {
  readonly folderId: string;
  readonly baseVersion: number;
  readonly nonce: string;
}

/** A folder in a workspace. */
export interface FolderRef {
  readonly workspaceId: string;
  readonly folderId: string;
}

/** A small encrypted record (comment, event or check) in a workspace. */
export interface RecordRef {
  readonly workspaceId: string;
  /** The comment, event or check ID. */
  readonly id: string;
}

/** The context of a note version. */
export function noteContext(ref: NoteRef): BlobContext {
  return { kind: "note", workspaceId: ref.workspaceId, id: ref.noteId };
}

/**
 * The context of a pending change. The server makes pending change IDs only when it stores the
 * change, so the proposal is bound to its note, folder, base version and the agent's nonce: the
 * server can't present it for another note, folder or base, and a replay repeats the nonce.
 */
export function pendingContext(ref: PendingRef): BlobContext {
  return {
    kind: "pending_change",
    workspaceId: ref.workspaceId,
    id: `${ref.noteId}:${ref.folderId}:${String(ref.baseVersion)}:${ref.nonce}`,
  };
}

/** The context of a note title kept apart from the note (for example in a list cache). */
export function titleContext(ref: NoteRef): BlobContext {
  return { kind: "title", workspaceId: ref.workspaceId, id: ref.noteId };
}

/** The context of a folder name. */
export function folderNameContext(ref: FolderRef): BlobContext {
  return { kind: "folder_name", workspaceId: ref.workspaceId, id: ref.folderId };
}

/** The context of a workspace name (its ID is the workspace ID). */
export function workspaceNameContext(workspaceId: string): BlobContext {
  return { kind: "workspace_name", workspaceId, id: workspaceId };
}

/** The context of a comment record. */
export function commentContext(ref: RecordRef): BlobContext {
  return { kind: "comment", workspaceId: ref.workspaceId, id: ref.id };
}

/** The context of a history event's details. */
export function eventContext(ref: RecordRef): BlobContext {
  return { kind: "event", workspaceId: ref.workspaceId, id: ref.id };
}

/** The context of an agent's check record. */
export function checkContext(ref: RecordRef): BlobContext {
  return { kind: "check", workspaceId: ref.workspaceId, id: ref.id };
}

/** The context of a serialized search index; one index per workspace unless `indexId` says else. */
export function searchIndexContext(workspaceId: string, indexId = workspaceId): BlobContext {
  return { kind: "search_index", workspaceId, id: indexId };
}

/** An agent token of a workspace. */
export interface AgentRef {
  readonly workspaceId: string;
  readonly tokenId: string;
}

/** The context of an agent's name (the name a person gave a connected agent). */
export function agentNameContext(ref: AgentRef): BlobContext {
  return { kind: "agent_name", workspaceId: ref.workspaceId, id: ref.tokenId };
}

/** The kinds of blob that stay in a client's own encrypted cache and are never uploaded. */
export const LOCAL_BLOB_KINDS = ["search_index", "graph_layout"] as const;
export type LocalBlobKind = (typeof LOCAL_BLOB_KINDS)[number];

/** A local-cache blob: its kind, its workspace and its id (by default the workspace id). */
export interface LocalBlobRef {
  readonly workspaceId: string;
  readonly kind: LocalBlobKind;
  readonly id?: string;
}

/** The context of a local-cache blob. */
export function localBlobContext(ref: LocalBlobRef): BlobContext {
  return { kind: ref.kind, workspaceId: ref.workspaceId, id: ref.id ?? ref.workspaceId };
}
