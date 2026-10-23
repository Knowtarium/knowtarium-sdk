import { fromBase64Url } from "../../crypto/index.js";
import { type Folder, type FolderId, routes } from "../../protocol/index.js";
import { isSyncApiError, RequestValidationError } from "../errors/index.js";
import { requireIdentity, type SyncContext, withCurrentKey, withKeys } from "../sync/context.js";
import type { FolderEventEntry } from "../sync/folder-events.js";
import {
  decryptFolderName,
  encryptFolderName,
  signFolderCreated,
  signFolderMoved,
  signingFields,
} from "../vault/index.js";

/*
 * Undoing an agent's folder change (protocol 3), as the person's own actions: a created folder is
 * deleted (when empty), a renamed one renamed back, a moved one moved back (signed
 * `folder_moved`), a deleted one revived under its own ID, its stored parent and its last name
 * (signed `folder_created`). Each first checks that nothing changed since, and answers instead of
 * throwing for what can be expected; each is safe to retry.
 */

/**
 * What undoing a folder change did: `saved` (done now, or by an earlier attempt), `moved_on` (the
 * folder changed since: renamed or moved again, or deleted), `not_empty` (a created folder holds
 * something: undo or move that first), `parent_missing` (the parent it goes back to, or is
 * revived under, is deleted: undo that first).
 */
export type UndoFolderResult =
  | {
      readonly status: "saved";
      readonly folder: Folder | null;
      readonly workspaceVersion: number | null;
    }
  | { readonly status: "moved_on" | "not_empty" }
  | { readonly status: "parent_missing"; readonly parentId: FolderId };

/** A parent an agent's folder change signed (null: the top level). */
function signedParent(
  entry: FolderEventEntry,
  field: "parentId" | "fromParentId",
): FolderId | null {
  const fields = entry.event.signed?.envelope as Partial<Record<string, string>> | undefined;
  return (fields?.[field] ?? null) as FolderId | null;
}

/** The workspace's live folders by ID (a person's session sees every one). */
async function liveFolders(context: SyncContext): Promise<Map<string, Folder>> {
  const { data } = await context.api.call(routes.listFolders, {
    params: { workspaceId: context.workspaceId },
  });
  return new Map(data.folders.map((folder) => [folder.id, folder]));
}

/**
 * A person undoes an agent's folder change (session): `entry` is the change from
 * `fetchFolderEvents` (or `agentActions`), which must be an agent's that verified. See
 * `UndoFolderResult` for the answers; the server's own refusals are thrown.
 */
export async function undoAgentFolderEvent(
  context: SyncContext,
  entry: FolderEventEntry,
  options: { readonly signedAt?: string } = {},
): Promise<UndoFolderResult> {
  const identity = requireIdentity(context, "undoAgentFolderEvent");
  const { event } = entry;
  if (entry.agent === null || entry.signature !== "verified") {
    throw new RequestValidationError("undoAgentFolderEvent", "params", ["event"]);
  }
  const { workspaceId } = context;
  const folderId = event.folderId;
  const folders = await liveFolders(context);
  const current = folders.get(folderId);
  const signedAt = options.signedAt === undefined ? {} : { signedAt: options.signedAt };
  const saved = (folder: Folder | null, workspaceVersion: number | null) =>
    ({ status: "saved", folder, workspaceVersion }) as const;

  switch (event.action) {
    case "created":
    case "restored": {
      // undone already (or deleted since: either way it is gone)
      if (current === undefined) return saved(null, null);
      try {
        const { data } = await context.api.call(routes.deleteFolder, {
          params: { workspaceId, folderId },
        });
        return saved(null, data.workspaceVersion);
      } catch (error) {
        if (isSyncApiError(error, "not_empty")) return { status: "not_empty" };
        if (isSyncApiError(error, "not_found")) return saved(null, null);
        throw error;
      }
    }
    case "renamed": {
      if (current === undefined || event.encNameBefore === null || entry.nameBefore === null) {
        return { status: "moved_on" };
      }
      if (current.encName !== event.encNameAfter) {
        // renamed back already (an earlier attempt), or renamed again since
        const name = await withKeys(context, (keys) =>
          decryptFolderName(keys, { workspaceId, folderId }, current.encName),
        );
        return name === entry.nameBefore ? saved(current, null) : { status: "moved_on" };
      }
      const before = entry.nameBefore;
      return withCurrentKey(context, async (keys) => {
        const encName = encryptFolderName(keys.current, { workspaceId, folderId }, before);
        const { data } = await context.api.call(routes.updateFolder, {
          params: { workspaceId, folderId },
          body: { encName },
        });
        return saved(data.folder, data.workspaceVersion);
      });
    }
    case "moved": {
      // the parents the agent signed, never the server's word
      const from = signedParent(entry, "fromParentId");
      if (current === undefined) return { status: "moved_on" };
      if (current.parentId === from) return saved(current, null);
      if (current.parentId !== signedParent(entry, "parentId")) return { status: "moved_on" };
      const parentId = from;
      if (parentId !== null && !folders.has(parentId)) {
        return { status: "parent_missing", parentId };
      }
      const action = signFolderMoved(identity, { workspaceId, folderId, parentId, ...signedAt });
      const { data } = await context.api.call(routes.updateFolder, {
        params: { workspaceId, folderId },
        body: { parentId, ...signingFields(action) },
      });
      return saved(data.folder, data.workspaceVersion);
    }
    case "deleted": {
      // revived already (an earlier attempt, or by someone else)
      if (current !== undefined) return saved(current, null);
      const parentId = signedParent(entry, "parentId");
      if (parentId !== null && !folders.has(parentId)) {
        return { status: "parent_missing", parentId };
      }
      const name = entry.nameBefore;
      if (name === null) return { status: "moved_on" };
      try {
        // its last name, encrypted again with the current key (the workspace may have rotated)
        return await withCurrentKey(context, async (keys) => {
          const encName = encryptFolderName(keys.current, { workspaceId, folderId }, name);
          const action = signFolderCreated(identity, {
            workspaceId,
            folderId,
            parentId,
            encName: fromBase64Url(encName),
            ...signedAt,
          });
          const { data } = await context.api.call(routes.createFolder, {
            params: { workspaceId },
            body: { id: folderId, parentId, encName, ...signingFields(action) },
          });
          return saved(data.folder, data.workspaceVersion);
        });
      } catch (error) {
        if (!isSyncApiError(error, "already_exists")) throw error;
        return saved((await liveFolders(context)).get(folderId) ?? null, null);
      }
    }
  }
}
