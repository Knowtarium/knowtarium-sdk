import type { FolderId, NoteId } from "../../protocol/index.js";
import { routes } from "../../protocol/index.js";
import {
  isSyncApiError,
  isVaultError,
  RequestValidationError,
  VaultError,
} from "../errors/index.js";
import { requireIdentity, type SyncContext } from "../sync/context.js";
import {
  acceptNote,
  readCurrentVersion,
  readNoteVersion,
  type VerifiedNote,
} from "../sync/notes.js";
import type { WriteResult } from "../sync/results.js";
import { deleteNote } from "../sync/writes.js";
import {
  landedRestore,
  personWroteVersion,
  restoreVersion,
  type RestoreVerify,
} from "./restore.js";

/** The other notes' names in a folder, or how to get them for the folder the undo writes to. */
export type TakenNames = readonly string[] | ((folderId: FolderId) => readonly string[]);

/**
 * The version before an agent's one, verified: its content under a person's or an agent's
 * signature, or a delete marker under a person's signed `deleted`. The versions list only says
 * which to expect; a missing or unverifiable version throws `untrusted_signature`, so a server
 * can't turn an undo into a delete (or a restore of something else).
 */
async function verifiedBefore(
  context: SyncContext,
  noteId: NoteId,
  version: number,
): Promise<VerifiedNote> {
  const { data } = await context.api.call(routes.listVersions, {
    params: { workspaceId: context.workspaceId, noteId },
    query: { since: version - 1, limit: 1 },
  });
  const listed = data.versions.find((entry) => entry.version === version);
  if (listed === undefined) {
    throw new VaultError("untrusted_signature", "the version before the agent's is missing");
  }
  try {
    return await readNoteVersion(context, { noteId, version, deleted: listed.deleted });
  } catch (error) {
    // listed as content, but the server has no bytes for it
    if (isSyncApiError(error, "not_found") || isVaultError(error, "missing_signature")) {
      throw new VaultError("untrusted_signature", "the version before the agent's is missing");
    }
    throw error;
  }
}

/**
 * A person undoes an agent's direct write (session): version `version` must be an agent's
 * (`agent_edited`, verified under its vouched key) and still the note's current one. The version
 * before it comes back as a new person-signed version (`restoreVersion`: a signed `edited` plus a
 * signed `restored` event, the person as author), in that version's own folder, so undoing a move
 * moves the note back: pass `takenNames` as a function to get the names in that folder, and
 * `verify` as a function of that folder too (false where agents apply changes directly, so no
 * `verified` entry is added). When that version is an agent's too (`agent_edited`, an applied
 * check on top of an agent's version, or one the engine can't tell), no `verified` entry is added
 * whatever `verify` says, and its `human:` entries in `verified` go (agents' entries stay): the
 * person never reviewed that content, and their signed undo must not carry entries they never
 * signed. `generated` names the person, as for any restore. Undoing
 * an agent-created note (version 1), or a write on top of a delete marker (verified), is a signed
 * `deleted` instead.
 *
 * If the note has moved past `version`, returns both sides as a conflict, like any write, and
 * nothing is saved. Safe to retry: a restore or a delete that already got through isn't saved
 * twice, and a restore whose signed `restored` event is stored is answered as saved before the
 * version before the agent's is read (its content may have been removed after the history period
 * once the undo replaced the agent's version). A 410 for `version` while it is the note's current
 * one throws `version_mismatch` (a lying server), never a `VersionPrunedError`.
 */
export async function undoAgentVersion(
  context: SyncContext,
  noteId: NoteId,
  version: number,
  options: {
    readonly takenNames: TakenNames;
    readonly signedAt?: string;
    readonly verify?: RestoreVerify;
  },
): Promise<WriteResult> {
  const identity = requireIdentity(context, "undoAgentVersion");
  const { workspaceId } = context;
  const { data } = await context.api.call(routes.getNote, { params: { workspaceId, noteId } });
  const note = data.note;
  if (version > 1 && note.currentVersion === version + 1) {
    // a retry after an undo that got through: done, without reading the version before the
    // agent's, which nothing protects any more
    const landed = await landedRestore(context, noteId, note, {
      fromVersion: version - 1,
      actor: `human:${identity.accountId}`,
    });
    if (landed !== null) return landed;
  }
  // the agent's version is meant to be the current one, never removed: a 410 for it then is a
  // lying server (`version_mismatch`); once superseded, it can be removed like any older version
  const read = note.currentVersion <= version ? readCurrentVersion : readNoteVersion;
  const undone = await read(context, { noteId, version });
  if (undone.event.signed?.envelope.type !== "agent_edited") {
    throw new RequestValidationError("undoAgentVersion", "params", ["version"]);
  }
  const before = version > 1 ? await verifiedBefore(context, noteId, version - 1) : null;
  if (before !== null && before.text !== null) {
    const { takenNames } = options;
    // the person never reviewed what an agent wrote: no `verified` entry for it, whatever
    // `verify` (`restoreVersion` drops the `human:` entries it carries, which no person signed)
    const verify = (await personWroteVersion(context, before)) ? options.verify : false;
    return restoreVersion(context, noteId, version - 1, {
      baseVersion: version,
      folderId: before.folderId,
      takenNames: typeof takenNames === "function" ? takenNames(before.folderId) : takenNames,
      ...(options.signedAt === undefined ? {} : { signedAt: options.signedAt }),
      ...(verify === undefined ? {} : { verify }),
    });
  }
  // the agent created the note (or brought a deleted one back): undoing it deletes it
  if (note.currentVersion === version + 1 && note.deleted) {
    // an earlier attempt got through: the verified delete marker is the result
    const now = await readCurrentVersion(context, {
      noteId,
      folderId: note.folderId,
      version: note.currentVersion,
      deleted: true,
      createdAt: note.createdAt,
    });
    return {
      status: "saved",
      note: await acceptNote(context, now),
      workspaceVersion: now.event.seq,
    };
  }
  return deleteNote(context, {
    noteId,
    baseVersion: version,
    ...(options.signedAt === undefined ? {} : { signedAt: options.signedAt }),
  });
}
