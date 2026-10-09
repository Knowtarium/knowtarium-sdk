import { mergeNoteNames, uniqueName } from "../../core/files/index.js";
import { mergeNotes, type NoteMerge } from "../../core/history/index.js";
import type { DiffLimits } from "../../core/history/diff3.js";
import { isVersionPruned } from "../errors/index.js";
import type { SyncContext } from "../sync/context.js";
import { readNoteVersion } from "../sync/notes.js";
import type { WriteConflict } from "../sync/results.js";

/** A merged note: the text merge, the file name to store, and a rename both sides made. */
export type MergedNote = NoteMerge & {
  /** The name to store (null only when neither side has one). */
  readonly name: string | null;
  /** Both sides renamed the note differently: shown for the person to choose (`name` is theirs). */
  readonly nameConflict: { readonly mine: string; readonly theirs: string } | null;
  /**
   * The version the edit started from was removed after the workspace's history period, so the
   * merge is two-way (mine against theirs, with no common base): every difference shows as a
   * conflict to choose (a frontmatter field only one side has too), none is taken for granted,
   * and differing names are a `nameConflict`.
   */
  readonly basePruned: boolean;
};

/**
 * The three-way merge of a 409 (`WriteConflict`): fetches and verifies the version the edit
 * started from (none for a new note, version 0, or a delete marker) and merges both sides against
 * it with core's `mergeNotes`. A deleted side merges as empty text. When the base's content was
 * removed after the history period, the merge goes on without it (`basePruned`), as a two-way
 * merge; any other failure to read it still throws.
 *
 * The file name follows core's `mergeNoteNames` (the side that renamed it; `nameConflict` when
 * both did, differently). Pass `takenNames` (the other notes' names in the folder) and a contested
 * name gets `uniqueName`.
 */
export async function mergeConflict(
  context: SyncContext,
  conflict: WriteConflict,
  options: { readonly limits?: DiffLimits; readonly takenNames: readonly string[] },
): Promise<MergedNote> {
  const baseVersion = conflict.mine.baseVersion;
  const read =
    baseVersion === 0
      ? null
      : await readNoteVersion(context, {
          noteId: conflict.theirs.noteId,
          version: baseVersion,
        }).catch((error: unknown) => {
          if (!isVersionPruned(error)) throw error;
          return "pruned" as const;
        });
  const basePruned = read === "pruned";
  const base = basePruned ? null : read;
  const merged = mergeNotes(
    {
      base: base?.text ?? null,
      mine: conflict.mine.text ?? "",
      theirs: conflict.theirs.text ?? "",
      baseUnknown: basePruned,
    },
    options.limits ?? {},
  );
  const names = { mine: conflict.mine.name, theirs: conflict.theirs.name };
  // without the base, nobody can tell which side renamed the note: differing names are a choice
  const { name, conflict: nameConflict } =
    basePruned && names.mine !== null && names.theirs !== null && names.mine !== names.theirs
      ? { name: names.theirs, conflict: { mine: names.mine, theirs: names.theirs } }
      : mergeNoteNames({ base: base?.name ?? null, ...names });
  return {
    ...merged,
    name: name === null ? null : uniqueName(name, options.takenNames, conflict.theirs.noteId),
    nameConflict,
    basePruned,
  };
}
