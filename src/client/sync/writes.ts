import { normalizeNoteName } from "../../core/files/index.js";
import {
  type CheckId,
  type FolderId,
  formatVersionTag,
  type NoteId,
  routes,
} from "../../protocol/index.js";
import { isSyncApiError } from "../errors/index.js";
import {
  encryptNote,
  signCheckApplied,
  signDeleted,
  signEdited,
  signingHeaders,
} from "../vault/index.js";
import { requireIdentity, type SyncContext, withCurrentKey } from "./context.js";
import { acceptNote, checkStoredWrite, readCurrentNote } from "./notes.js";
import type { WriteConflict, WriteResult } from "./results.js";

/** A person's new version of a note. */
export interface NoteWrite {
  readonly noteId: NoteId;
  /** The folder the note sits in after the write (another folder moves it). */
  readonly folderId: FolderId;
  /** The version the edit started from; 0 creates the note. */
  readonly baseVersion: number;
  /** The note's file name within its folder (`pricing.md`); another name renames it. */
  readonly name: string;
  /** The whole OKF markdown file. */
  readonly text: string;
  /**
   * When the person signs the write (UTC with milliseconds, within `SIGNATURE_MAX_SKEW_SECONDS`
   * of now, else `RequestValidationError`); defaults to now. Pass the time the text's own
   * `verified` entry names, so the two agree. Ignored for an agent's proposal (unsigned).
   */
  readonly signedAt?: string;
  /**
   * The agent's check record this write applies (its `verified` entry written into the note): the
   * write is signed as `check_applied` and sent with `Knowtarium-Check-Id`, so the server marks
   * the record applied. A person's session only.
   */
  readonly checkId?: CheckId;
}

/** Both versions of a 409, the server's one verified and decrypted. */
export async function conflictResult(
  context: SyncContext,
  noteId: NoteId,
  mine: WriteConflict["mine"],
): Promise<WriteConflict> {
  return { status: "conflict", mine, theirs: await readCurrentNote(context, noteId) };
}

/**
 * Encrypts, signs (`edited`) and stores a new version if `baseVersion` is still current
 * (`If-Match`). On 409 it returns both versions for the merge UI instead of throwing.
 */
export async function writeNote(context: SyncContext, write: NoteWrite): Promise<WriteResult> {
  const identity = requireIdentity(context, "writeNote");
  const { workspaceId } = context;
  try {
    return await withCurrentKey(context, async (keys) => {
      const ciphertext = encryptNote(
        keys.current,
        { workspaceId, noteId: write.noteId },
        { name: write.name, text: write.text },
      );
      const signing = {
        workspaceId,
        noteId: write.noteId,
        folderId: write.folderId,
        baseVersion: write.baseVersion,
        ciphertext,
        ...(write.signedAt === undefined ? {} : { signedAt: write.signedAt }),
      };
      const action =
        write.checkId === undefined
          ? signEdited(identity, signing)
          : signCheckApplied(identity, { ...signing, checkId: write.checkId });
      const { data } = await context.api.call(routes.writeNote, {
        params: { workspaceId, noteId: write.noteId },
        headers: {
          "if-match": formatVersionTag(write.baseVersion),
          "knowtarium-folder-id": write.folderId,
          ...signingHeaders(action),
          ...(write.checkId === undefined ? {} : { "knowtarium-check-id": write.checkId }),
        },
        body: ciphertext,
      });
      checkStoredWrite(context, data, { ...write, ciphertext });
      const note = await acceptNote(context, {
        noteId: write.noteId,
        folderId: data.note.folderId,
        version: data.note.currentVersion,
        name: normalizeNoteName(write.name),
        text: write.text,
        createdAt: data.note.createdAt,
        ciphertext,
        event: data.event,
      });
      return { status: "saved" as const, note, workspaceVersion: data.workspaceVersion };
    });
  } catch (error) {
    if (!isSyncApiError(error, "conflict")) throw error;
    return conflictResult(context, write.noteId, {
      baseVersion: write.baseVersion,
      name: write.name,
      text: write.text,
    });
  }
}

/** Deletes a note as a signed (`deleted`) new version, if `baseVersion` is still current. */
export async function deleteNote(
  context: SyncContext,
  target: { readonly noteId: NoteId; readonly baseVersion: number; readonly signedAt?: string },
): Promise<WriteResult> {
  const identity = requireIdentity(context, "deleteNote");
  const { workspaceId } = context;
  const action = signDeleted(identity, {
    workspaceId,
    noteId: target.noteId,
    baseVersion: target.baseVersion,
    ...(target.signedAt === undefined ? {} : { signedAt: target.signedAt }),
  });
  try {
    const { data } = await context.api.call(routes.deleteNote, {
      params: { workspaceId, noteId: target.noteId },
      headers: { "if-match": formatVersionTag(target.baseVersion), ...signingHeaders(action) },
    });
    checkStoredWrite(context, data, { noteId: target.noteId, baseVersion: target.baseVersion });
    const note = await acceptNote(context, {
      noteId: target.noteId,
      folderId: data.note.folderId,
      version: data.note.currentVersion,
      name: null,
      text: null,
      createdAt: data.note.createdAt,
      event: data.event,
    });
    return { status: "saved", note, workspaceVersion: data.workspaceVersion };
  } catch (error) {
    if (!isSyncApiError(error, "conflict")) throw error;
    return conflictResult(context, target.noteId, {
      baseVersion: target.baseVersion,
      name: null,
      text: null,
    });
  }
}
