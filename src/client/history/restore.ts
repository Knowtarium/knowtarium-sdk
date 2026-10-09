import { noteNameFromTitle, noteTitle, uniqueName } from "../../core/files/index.js";
import { type RestoreOptions, restoreText } from "../../core/history/index.js";
import type { Actor } from "../../core/frontmatter/index.js";
import { parseNote } from "../../core/note/index.js";
import { readProvenance } from "../../core/trust/index.js";
import type { FolderId, NoteEvent, NoteId, NoteMeta } from "../../protocol/index.js";
import { routes } from "../../protocol/index.js";
import { RequestValidationError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { requireIdentity, type SyncContext, withCurrentKey } from "../sync/context.js";
import {
  acceptNote,
  fetchEvents,
  readCurrentVersion,
  readNoteVersion,
  type VerifiedNote,
} from "../sync/notes.js";
import type { WriteResult } from "../sync/results.js";
import { writeNote } from "../sync/writes.js";
import { encryptEvent, signingFields, signingTime, signRecorded } from "../vault/index.js";
import { readEventEntry } from "./load.js";

/**
 * Whether a person wrote a verified version's content: a person's `edited` or `approved`, or an
 * applied check on top of one (`Confirmations.personWrote`). Not an agent's version, nor an
 * applied check whose earlier versions the engine can't tell apart (after reading the note's
 * events again).
 */
export async function personWroteVersion(
  context: SyncContext,
  note: VerifiedNote,
): Promise<boolean> {
  const { confirmations } = context;
  if (note.event.signed?.envelope.type === "check_applied") {
    confirmations.addEvents(await fetchEvents(context, { noteId: note.noteId }));
  }
  return confirmations.personWrote(note.noteId, note.version, note.event);
}

/**
 * Whether a restore adds the person's `verified` entry: a fixed answer, or one for the folder
 * the restore writes to (an undo can write to another folder than the note's current one).
 */
export type RestoreVerify = boolean | ((folderId: FolderId) => boolean);

/**
 * Whether `text` is exactly what restoring `oldText` as `actor` wrote (at the time it names),
 * with the person's `verified` entry or without it (`verify`, the answer for the folder written to)
 * and with the old `human:` entries or without them (`stripHumanEntries`).
 */
function isRestoreOf(text: string, oldText: string, actor: Actor, stamps: RestoreOptions): boolean {
  const at = readProvenance(parseNote(text).frontmatter?.data ?? {}).generated?.at;
  if (at == null) return false;
  try {
    return restoreText(oldText, actor, at, stamps) === text;
  } catch {
    return false;
  }
}

/** What a `restored` event says: `actor` restored `fromVersion` as `version`. */
interface RestoreDetails {
  readonly fromVersion: number;
  readonly version: number;
  readonly actor: Actor;
}

/** Whether `events` hold a verified `restored` event by `actor` for exactly this restore. */
async function hasRestoredEvent(
  context: SyncContext,
  events: readonly NoteEvent[],
  details: RestoreDetails,
): Promise<boolean> {
  for (const event of events) {
    if (event.noteVersion !== details.version || event.ciphertext === null) continue;
    const entry = await readEventEntry(context, event);
    if (
      entry.signature === "verified" &&
      entry.actor === details.actor &&
      entry.event.type === "restored" &&
      entry.event.fromVersion === details.fromVersion
    ) {
      return true;
    }
  }
  return false;
}

/**
 * When the note's current version (`note`, as `getNote` answered it) is already the restore of
 * `fromVersion` by `actor`: an earlier attempt got through and its signed `restored` event is
 * stored. Answers that version, verified and accepted as current, as a saved write; null
 * otherwise. It needs only the event and the current version, never the old version's content,
 * which may have been removed after the history period since.
 */
export async function landedRestore(
  context: SyncContext,
  noteId: NoteId,
  note: Pick<NoteMeta, "currentVersion" | "folderId" | "deleted" | "createdAt">,
  details: { readonly fromVersion: number; readonly actor: Actor },
): Promise<WriteResult | null> {
  if (note.deleted) return null;
  const version = note.currentVersion;
  const events = await fetchEvents(context, { noteId });
  if (!(await hasRestoredEvent(context, events, { ...details, version }))) return null;
  const now = await readCurrentVersion(context, {
    noteId,
    folderId: note.folderId,
    version,
    createdAt: note.createdAt,
    events,
  });
  // the event names the write; the write itself must be a person's
  if (now.text === null || now.event.signed?.envelope.type !== "edited") return null;
  return { status: "saved", note: await acceptNote(context, now), workspaceVersion: now.event.seq };
}

/** Records the signed `restored` event, unless a verified one for this restore exists already. */
async function recordRestore(
  context: SyncContext,
  details: RestoreDetails & { readonly noteId: NoteId; readonly at: string },
): Promise<void> {
  const identity = requireIdentity(context, "restoreVersion");
  const { workspaceId } = context;
  const events = await fetchEvents(context, { noteId: details.noteId });
  if (await hasRestoredEvent(context, events, details)) return;
  await withCurrentKey(context, async (keys) => {
    const id = newId("evt");
    const record = {
      type: "restored",
      actor: details.actor,
      at: details.at,
      fromVersion: details.fromVersion,
      version: details.version,
    };
    const sealed = encryptEvent(keys.current, { workspaceId, id }, record);
    const action = signRecorded(identity, {
      workspaceId,
      noteId: details.noteId,
      eventId: id,
      ciphertext: sealed.bytes,
    });
    await context.api.call(routes.addEvent, {
      params: { workspaceId },
      body: {
        id,
        noteId: details.noteId,
        noteVersion: details.version,
        ciphertext: sealed.ciphertext,
        ...signingFields(action),
      },
      idempotent: true,
    });
  });
}

/**
 * Restores an old version as a new one (its text and its file name): reads and verifies it,
 * marks it as the person's change
 * (`restoreText`, with `generated.at` and `verified.at` equal to the signed write's time; pass
 * `verify: false`, or a function of the folder written to that answers false, where agents apply
 * changes directly, so no `verified` entry is added), saves it as a signed write on top of the
 * current version, and records a signed `restored` event naming both versions. When no person
 * wrote the old version (`personWroteVersion`: an agent's, an applied check on an agent's, or one
 * the engine can't tell), its `human:` entries in `verified` go, always: the person's signed
 * restore would otherwise endorse entries they never signed. Agents' entries stay.
 *
 * Pass `takenNames`, the names of the other notes in the folder, so a name another note took since
 * isn't reused (`uniqueName`).
 *
 * Safe to retry: pass `baseVersion`, the version that was current when the person chose to
 * restore. If the note has moved past it and the current version is this very restore (an earlier
 * attempt got through), nothing is saved twice; the missing event, if any, is recorded. Once that
 * event is stored, a retry answers the saved restore without reading the old version, whose
 * content may have been removed after the history period since. If it moved for another reason,
 * or a 409 comes back, both sides are returned like any write. A 410 for the note's current
 * version throws `version_mismatch` (a lying server), never a `VersionPrunedError`.
 */
export async function restoreVersion(
  context: SyncContext,
  noteId: NoteId,
  version: number,
  options: {
    readonly baseVersion?: number;
    readonly takenNames: readonly string[];
    readonly signedAt?: string;
    /**
     * The folder to save into; defaults to the note's current one. Undoing an agent's move
     * passes the old version's own (verified) folder, so the note moves back.
     */
    readonly folderId?: FolderId;
    /** Whether to add the person's `verified` entry (default true); see `RestoreVerify`. */
    readonly verify?: RestoreVerify;
  },
): Promise<WriteResult> {
  const identity = requireIdentity(context, "restoreVersion");
  const { workspaceId } = context;
  const actor: Actor = `human:${identity.accountId}`;
  const { data } = await context.api.call(routes.getNote, { params: { workspaceId, noteId } });
  const current = data.note.currentVersion;
  const base = options.baseVersion ?? current;
  if (current !== base) {
    // a retry after an attempt that got through, its event recorded: done, even if the old
    // version's content was removed since
    const landed = await landedRestore(context, noteId, data.note, { fromVersion: version, actor });
    if (landed !== null) return landed;
  }
  const old = await readNoteVersion(context, { noteId, version });
  if (old.text === null) throw new RequestValidationError("restoreVersion", "params", ["version"]);
  const oldText = old.text;
  // the old version's file name comes back too; a legacy one is named after its title
  // (made unique against the folder's other notes, `takenNames`, when another took it since)
  const oldName = uniqueName(
    old.name ?? noteNameFromTitle(noteTitle(oldText, noteId)),
    options.takenNames,
    noteId,
  );
  // the signed write's time, which the restored text names too (checked here, before any write)
  const at = signingTime(identity, "edited", options.signedAt);
  // the folder the restore writes to, and whether a save there carries the person's check
  const folderId = options.folderId ?? data.note.folderId;
  const { verify = true } = options;
  const stamps: RestoreOptions = {
    verify: typeof verify === "function" ? verify(folderId) : verify,
    // `human:` entries no person signed into that version never come back under their signature
    stripHumanEntries: !(await personWroteVersion(context, old)),
  };

  if (current !== base) {
    // the note's current version: a 410 for it is a lying server (`version_mismatch`)
    const now = await readCurrentVersion(context, {
      noteId,
      folderId: data.note.folderId,
      version: current,
      deleted: data.note.deleted,
      createdAt: data.note.createdAt,
    });
    const snapshot = await acceptNote(context, now);
    if (now.text !== null && isRestoreOf(now.text, oldText, actor, stamps)) {
      const at = readProvenance(parseNote(now.text).frontmatter?.data ?? {}).generated?.at ?? "";
      await recordRestore(context, { noteId, fromVersion: version, version: current, actor, at });
      return { status: "saved", note: snapshot, workspaceVersion: now.event.seq };
    }
    return {
      status: "conflict",
      mine: {
        baseVersion: base,
        name: oldName,
        text: restoreText(oldText, actor, at, stamps),
      },
      theirs: snapshot,
    };
  }

  const result = await writeNote(context, {
    noteId,
    folderId,
    baseVersion: current,
    name: oldName,
    text: restoreText(oldText, actor, at, stamps),
    signedAt: at,
  });
  if (result.status !== "saved") return result;
  await recordRestore(context, {
    noteId,
    fromVersion: version,
    version: result.note.version,
    actor,
    at,
  });
  return result;
}
