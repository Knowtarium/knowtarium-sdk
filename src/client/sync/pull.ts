import { type ChangeEntry, type NoteEvent, routes } from "../../protocol/index.js";
import {
  InvalidResponseError,
  isSyncApiError,
  isVersionPruned,
  VaultError,
} from "../errors/index.js";
import { decryptFolderName, decryptWorkspaceName } from "../vault/index.js";
import { decryptAttachmentMeta } from "../attachments/meta.js";
import { type SyncContext, withKeys } from "./context.js";
import { attachmentSnapshot } from "./events.js";
import { prefetchVersions, versionKey } from "./batch.js";
import { reportRevokedAgentNotes } from "./hydrate.js";
import { acceptNote, fetchEvents, readCurrentNote, readNoteVersion } from "./notes.js";
import { isIntegrityError } from "./quarantine.js";

function changeKey(change: ChangeEntry): string {
  switch (change.kind) {
    case "workspace":
      return "workspace";
    case "folder":
      return `folder:${change.folderId}`;
    case "note":
      return `note:${change.noteId}`;
    case "pending":
      return `pending:${change.pendingId}`;
    case "event":
      return `event:${change.eventId}`;
    case "comment":
      return `comment:${change.commentId}`;
    case "check":
      return `check:${change.checkId}`;
    case "attachment":
      return `attachment:${change.attachmentId}`;
  }
}

/** The latest entry per object, in feed order. */
function latestPerObject(changes: readonly ChangeEntry[]): ChangeEntry[] {
  const latest = new Map<string, ChangeEntry>();
  for (const change of changes) {
    const key = changeKey(change);
    latest.delete(key);
    latest.set(key, change);
  }
  return [...latest.values()];
}

async function applyNote(
  context: SyncContext,
  change: Extract<ChangeEntry, { kind: "note" }>,
  events: readonly NoteEvent[],
  prefetched: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const seen = await context.trust.noteVersion(context.workspaceId, change.noteId);
  if (change.version < seen) {
    throw new VaultError("rollback", "the feed offers an older note version than one seen");
  }
  if (change.version === seen && !context.quarantine.has(change.noteId)) {
    const cached = await context.cache?.noteVersion(context.workspaceId, change.noteId);
    if (cached === seen) return;
  }
  const ciphertext = prefetched.get(versionKey(change.noteId, change.version));
  let note;
  try {
    note = await readNoteVersion(context, {
      noteId: change.noteId,
      folderId: change.folderId,
      version: change.version,
      deleted: change.deleted,
      events,
      createdAt: change.createdAt,
      ...(ciphertext === undefined ? {} : { ciphertext }),
    });
  } catch (error) {
    // only a superseded version is ever pruned: a newer one replaced it since this page was read,
    // and must be there (else the note is quarantined, never left at an older version silently)
    if (!isVersionPruned(error)) throw error;
    await readCurrentNote(context, change.noteId, { newerThan: change.version });
    return;
  }
  await acceptNote(context, note);
}

async function applyChange(
  context: SyncContext,
  change: ChangeEntry,
  events: readonly NoteEvent[],
  prefetched: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const { workspaceId, emitter } = context;
  switch (change.kind) {
    case "note":
      return applyNote(context, change, events, prefetched);
    case "folder": {
      const name = change.deleted
        ? null
        : await withKeys(context, (keys) =>
            decryptFolderName(keys, { workspaceId, folderId: change.folderId }, change.encName),
          );
      await context.cache?.putFolder({
        workspaceId,
        folderId: change.folderId,
        parentId: change.parentId,
        encName: change.encName,
        deleted: change.deleted,
        createdAt: change.createdAt,
      });
      emitter.emit({
        type: "folder",
        folder: {
          folderId: change.folderId,
          parentId: change.parentId,
          name,
          deleted: change.deleted,
          createdAt: change.createdAt,
        },
      });
      return;
    }
    case "workspace": {
      if (change.keyGeneration > (await context.trust.keyGeneration(workspaceId))) {
        // a rotation follows every revocation: the agent keys' revocations are read again too
        context.verifier.agentKeys.invalidate();
        const keys = await context.keys.refresh();
        emitter.emit({ type: "keys_rotated", keyGeneration: keys.current.generation });
        await reportRevokedAgentNotes(context);
      }
      const name = await withKeys(context, (keys) =>
        decryptWorkspaceName(keys, workspaceId, change.encName),
      );
      await context.cache?.putWorkspace(workspaceId, change);
      emitter.emit({
        type: "workspace",
        name,
        keyGeneration: change.keyGeneration,
        ...(change.agentPolicyRevision === undefined
          ? {}
          : { agentPolicyRevision: change.agentPolicyRevision }),
      });
      return;
    }
    case "attachment": {
      // the metadata is decrypted on read; the cache keeps it encrypted
      const meta =
        change.deleted || change.encMeta === null
          ? null
          : await withKeys(context, (keys) =>
              decryptAttachmentMeta(
                keys,
                { workspaceId, attachmentId: change.attachmentId, folderId: change.folderId },
                change.encMeta ?? "",
              ),
            );
      await context.cache?.putAttachment({
        workspaceId,
        attachmentId: change.attachmentId,
        folderId: change.folderId,
        encMeta: change.deleted ? null : change.encMeta,
        deleted: change.deleted,
        createdAt: change.createdAt,
      });
      emitter.emit({
        type: "attachment",
        attachment: attachmentSnapshot(
          change.attachmentId,
          change.folderId,
          meta,
          change.createdAt,
        ),
      });
      return;
    }
    default:
      emitter.emit({ type: "change", change });
  }
}

/**
 * Applies one page of the feed in order. The versions to download are fetched first in batches
 * (`prefetchVersions`), then every note is verified and applied as before. A note that fails
 * verification (rollback, bad or missing signature, wrong key) is quarantined, so one bad object
 * can't stall the sync; any other failure (network, server) stops the pull before the cursor
 * moves past the page.
 */
async function applyPage(
  context: SyncContext,
  changes: readonly ChangeEntry[],
  since: number,
): Promise<void> {
  const notes = changes.filter((change) => change.kind === "note");
  const until = Math.max(since, ...notes.map((change) => change.seq));
  const events = notes.length > 0 ? await fetchEvents(context, { since, until }) : [];
  // every signed write in the range counts, also those of versions a later one replaced
  context.confirmations.addEvents(events);
  const wanted = [];
  for (const change of notes) {
    if (change.deleted) continue;
    const seen = await context.trust.noteVersion(context.workspaceId, change.noteId);
    // the version seen before is read again when the cache lacks it (an emptied cache with the
    // trust marks still there: after sign-out, a memory fallback or clearWorkspace)
    const missing =
      change.version === seen &&
      (await context.cache?.noteVersion(context.workspaceId, change.noteId)) !== seen;
    if (change.version > seen || missing || context.quarantine.has(change.noteId)) {
      wanted.push({ noteId: change.noteId, version: change.version });
    }
  }
  const prefetched = await prefetchVersions(context, wanted);
  for (const change of changes) {
    try {
      await applyChange(context, change, events, prefetched);
    } catch (error) {
      if (!isIntegrityError(error)) throw error;
      if (change.kind === "note")
        await context.quarantine.add(change.noteId, change.version, error);
      else context.emitter.emit({ type: "error", error });
    }
  }
}

/**
 * Reads the feed from `since` page by page, applying each page and handing its cursor to
 * `commit` before asking for the next, so an interrupted pull resumes where it stopped. A page
 * that claims more without moving forward, or a workspace version below `since`, stops it.
 * Resolves with the final cursor.
 */
export async function pullFeed(
  context: SyncContext,
  since: number,
  pageSize: number,
  commit: (cursor: number) => Promise<void>,
): Promise<number> {
  let cursor = since;
  for (;;) {
    const { data } = await context.api.call(routes.listChanges, {
      params: { workspaceId: context.workspaceId },
      query: { since: cursor, limit: pageSize },
    });
    if (data.workspaceVersion < cursor) {
      throw new VaultError("rollback", "the workspace version went back");
    }
    const last = data.changes.at(-1);
    if (data.hasMore && (last === undefined || last.seq <= cursor)) {
      throw new InvalidResponseError("GET /workspaces/:workspaceId/changes", "no progress");
    }
    await applyPage(context, latestPerObject(data.changes), cursor);
    const next =
      data.hasMore && last !== undefined
        ? last.seq
        : Math.max(cursor, last?.seq ?? 0, data.workspaceVersion);
    await commit(next);
    cursor = next;
    if (!data.hasMore) return cursor;
  }
}

/**
 * Tries every quarantined note again: its current version, verified, releases it. A note that
 * still fails stays quarantined; a note that is gone is released.
 */
export async function retryQuarantine(context: SyncContext): Promise<void> {
  for (const { noteId, version } of context.quarantine.list()) {
    try {
      await readCurrentNote(context, noteId);
    } catch (error) {
      if (isSyncApiError(error, "not_found")) {
        await context.quarantine.release(noteId);
        continue;
      }
      if (!isIntegrityError(error)) throw error;
      await context.quarantine.add(noteId, version, error);
    }
  }
}
