// Read-only lookups over a workspace.
import type { ResolvedLink } from "../links/types.js";
import { normalizePath } from "../path/index.js";
import type { Folder, Note, Workspace } from "./types.js";

export function getNote(workspace: Workspace, id: string): Note | undefined {
  return workspace.notes.get(id);
}

/** The note at a path (normalized first, so `./a\\b.md` finds `a/b.md`). */
export function getNoteByPath(workspace: Workspace, path: string): Note | undefined {
  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch {
    return undefined;
  }
  const id = workspace.paths.get(normalized);
  return id === undefined ? undefined : workspace.notes.get(id);
}

/** Notes whose title matches, case-insensitively. */
export function findNotesByTitle(workspace: Workspace, title: string): Note[] {
  const wanted = title.trim().toLowerCase();
  return [...workspace.notes.values()].filter((note) => note.title.toLowerCase() === wanted);
}

export function getFolder(workspace: Workspace, path: string): Folder | undefined {
  return workspace.folders.get(path);
}

/** The notes directly in a folder, sorted by path. */
export function notesInFolder(workspace: Workspace, path: string): Note[] {
  const ids = workspace.folders.get(path)?.notes ?? [];
  return ids.flatMap((id) => workspace.notes.get(id) ?? []);
}

/** A folder's `index.md`. */
export function indexNoteOf(workspace: Workspace, folder: string): Note | undefined {
  const id = workspace.folders.get(folder)?.index;
  return id === null || id === undefined ? undefined : workspace.notes.get(id);
}

/** A folder's `log.md`. */
export function logNoteOf(workspace: Workspace, folder: string): Note | undefined {
  const id = workspace.folders.get(folder)?.log;
  return id === null || id === undefined ? undefined : workspace.notes.get(id);
}

/** A note's outgoing links, resolved, in body order. */
export function linksFrom(workspace: Workspace, id: string): readonly ResolvedLink[] {
  return workspace.links.get(id) ?? [];
}

/** Links from other notes (and the note itself) that resolve to this note. */
export function backlinksTo(workspace: Workspace, id: string): readonly ResolvedLink[] {
  return workspace.backlinks.get(id) ?? [];
}

/** Every ghost link (a link to no note), ordered by note path, line and column. */
export function ghostLinks(workspace: Workspace): ResolvedLink[] {
  const pathOf = (id: string) => workspace.notes.get(id)?.path ?? "";
  return [...workspace.ghosts.values()]
    .flat()
    .sort(
      (a, b) =>
        pathOf(a.from).localeCompare(pathOf(b.from)) || a.line - b.line || a.column - b.column,
    );
}

/** Notes with problems (broken frontmatter or invalid OKF fields). */
export function notesWithProblems(workspace: Workspace): Note[] {
  return [...workspace.notes.values()].filter((note) => note.problems.length > 0);
}
