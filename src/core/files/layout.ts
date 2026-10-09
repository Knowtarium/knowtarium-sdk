import { firstHeading } from "../bundle/okf-fields.js";
import type { ImportResult } from "../bundle/types.js";
import { parseNote } from "../note/index.js";
import { fileNameOf, folderOf, joinPath, normalizePath } from "../path/index.js";
import { MAX_NOTE_NAME_BYTES, normalizeNoteName, utf8Length } from "./note-file.js";

/** Characters a file or folder name can't hold on some system, controls and bidi overrides. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Whether a string is one path segment `normalizePath` keeps exactly as it is. */
function isSegment(name: string): boolean {
  try {
    return name !== "" && !name.includes("/") && normalizePath(name) === name;
  } catch {
    return false;
  }
}

/** Cuts a string to `maxBytes` UTF-8 bytes at a code point, then drops trailing dots and spaces. */
function fit(text: string, maxBytes: number): string {
  const chars = Array.from(text);
  while (chars.length > 0 && utf8Length(chars.join("")) > maxBytes) chars.pop();
  return chars.join("").replace(/[. ]+$/, "");
}

/**
 * A name made safe as one path segment, one `normalizePath` accepts as it is: unsafe characters
 * become `-`, no trailing dots or spaces, a Windows reserved base name (`aux`, `con.txt`) gets a
 * `_` in front, at most `maxBytes` UTF-8 bytes (cut at a code point, never inside one).
 * `fallback` when nothing usable is left.
 */
export function safeSegment(name: string, fallback: string, maxBytes = 200): string {
  const clean = (text: string): string | null => {
    let cleaned = fit(text.normalize("NFC").replace(UNSAFE, "-").trim(), maxBytes);
    if (WINDOWS_RESERVED.test(cleaned)) cleaned = fit(`_${cleaned}`, maxBytes);
    return cleaned === "." || cleaned === ".." || !isSegment(cleaned) ? null : cleaned;
  };
  // the fallback (an ID, say) is made safe the same way, whatever it holds
  return clean(name) ?? clean(fallback) ?? "_";
}

/**
 * A folder name as a path segment: kept exactly when it is a valid segment by the workspace path
 * rules (so imported names round-trip), else made safe.
 */
function folderSegment(name: string, id: string): string {
  try {
    if (normalizePath(name) === name && !name.includes("/") && name !== "") return name;
  } catch {
    // made safe below
  }
  return safeSegment(name, id);
}

/** A note's title: its `title` field, else its first heading, else `fallback`. */
export function noteTitle(text: string, fallback: string): string {
  const note = parseNote(text);
  const title = note.frontmatter?.data["title"];
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  return firstHeading(note.body) ?? fallback;
}

/**
 * A note file name made from a title (`Q3 pricing` gives `Q3 pricing.md`), always one that
 * `normalizeNoteName` accepts (`note.md` when nothing of the title is usable).
 */
export function noteNameFromTitle(title: string): string {
  try {
    return normalizeNoteName(`${safeSegment(title, "note", MAX_NOTE_NAME_BYTES - 3)}.md`);
  } catch {
    return "note.md";
  }
}

/** A stored note name as it is when it is a valid note name, else one made safe from it. */
function usableNoteName(name: string): string {
  try {
    if (normalizeNoteName(name) === name) return name;
  } catch {
    // made safe below
  }
  return noteNameFromTitle(name.replace(/\.md$/i, ""));
}

/**
 * A name as a case-insensitive file system may see it: NFC, then full case folding approximated
 * by upper then lower case (so `ß`, `ẞ` and `ss`, or the Kelvin sign and `k`, count as the same).
 */
export function foldName(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase();
}

/** `name` with ` (<tag>)` before its extension (if any), kept within the name length limit. */
function tagged(name: string, tag: string): string {
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  // the tag (an ID) made safe too, and short, whatever it holds
  const suffix = ` (${fit(tag.normalize("NFC").replace(UNSAFE, "-"), 64)})`;
  const room = MAX_NOTE_NAME_BYTES - utf8Length(suffix + extension);
  const chars = Array.from(stem);
  while (chars.length > 0 && utf8Length(chars.join("")) > room) chars.pop();
  return `${chars.join("")}${suffix}${extension}`;
}

/**
 * A name nobody in `taken` has (letter case ignored): `name` itself when free, else `name` tagged
 * with the end of `id`, then with the whole `id`, then with the `id` and a counter. Used for
 * every place a name could be contested: workspace paths, restoring an old name, approving a
 * proposal, merging a 409.
 */
export function uniqueName(name: string, taken: Iterable<string>, id: string): string {
  const used = new Set([...taken].map(foldName));
  const candidates = [name, tagged(name, id.slice(-6)), tagged(name, id)];
  for (const candidate of candidates) if (!used.has(foldName(candidate))) return candidate;
  for (let counter = 2; ; counter++) {
    const candidate = tagged(name, `${id} ${String(counter)}`);
    if (!used.has(foldName(candidate))) return candidate;
  }
}

/**
 * The file name a three-way merge keeps: the side that renamed the note wins; against a legacy
 * base without a name, their name counts as the rename. When both renamed it differently,
 * `conflict` holds both and `name` keeps theirs (the stored one) until the person chooses.
 */
export function mergeNoteNames(names: {
  readonly base: string | null;
  readonly mine: string | null;
  readonly theirs: string | null;
}): {
  readonly name: string | null;
  readonly conflict: { readonly mine: string; readonly theirs: string } | null;
} {
  const { base, mine, theirs } = names;
  const mineRenamed = mine !== null && base !== null && mine !== base;
  const theirsRenamed = theirs !== null && theirs !== base;
  if (mineRenamed && theirsRenamed && mine !== theirs) {
    return { name: theirs, conflict: { mine, theirs } };
  }
  if (mineRenamed) return { name: mine, conflict: null };
  if (theirsRenamed) return { name: theirs, conflict: null };
  return { name: mine ?? theirs, conflict: null };
}

/** A stored folder: its ID, its parent, its decrypted name and when it was created. */
export interface StoredFolder {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  /** When the server stored it; orders contested names (unknown sorts last). */
  readonly createdAt?: string | null;
}

/**
 * A stored note: its ID, its folder, its file name (null for a legacy note), its text and when
 * its first version was stored.
 */
export interface StoredNote {
  readonly id: string;
  readonly folderId: string;
  readonly name: string | null;
  readonly text: string;
  /** When version 1 was stored; the earliest note keeps a contested name (unknown sorts last). */
  readonly createdAt?: string | null;
}

/** Workspace paths for stored folders and notes. */
export interface WorkspaceLayout {
  /** Each folder's path (`""` for the root folder). */
  readonly folders: ReadonlyMap<string, string>;
  /** Each note's path (`<folder path>/<file name>`); no two are the same (letter case ignored). */
  readonly notes: ReadonlyMap<string, string>;
  /** The root folder's ID, if the workspace has one. */
  readonly root: string | null;
  /** Folders and notes shown under another name than the one stored, and why. */
  readonly renamed: readonly {
    readonly id: string;
    readonly path: string;
    /** `legacy`: no stored name; `duplicate`: taken; `invalid`: a stored name the rules refuse. */
    readonly reason: "legacy" | "duplicate" | "invalid";
  }[];
}

/** The workspace root folder's name: a top-level folder with no name. */
export const ROOT_FOLDER_NAME = "";

/** Whether a folder has the root folder's shape: no parent and an empty name. */
export function isRootFolder(folder: Pick<StoredFolder, "parentId" | "name">): boolean {
  return folder.parentId === null && folder.name === ROOT_FOLDER_NAME;
}

/** First signed write first (unknown times last), then by ID: who keeps a contested name. */
function byAge(
  a: { readonly id: string; readonly createdAt?: string | null },
  b: { readonly id: string; readonly createdAt?: string | null },
): number {
  const at = (entry: { readonly createdAt?: string | null }) =>
    entry.createdAt == null ? Number.POSITIVE_INFINITY : Date.parse(entry.createdAt);
  return at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The workspace root folder among stored folders: the oldest top-level folder with an empty
 * name (there should be one at most; any other is shown as an ordinary folder).
 */
export function rootFolderOf(folders: readonly StoredFolder[]): StoredFolder | null {
  return [...folders].filter(isRootFolder).sort(byAge)[0] ?? null;
}

/**
 * Builds workspace paths from what the sync API stores: folder names along each folder's parent
 * chain (kept exactly when valid path segments, else made safe) and each note's file name. The
 * root folder (the oldest top-level folder with an empty name) is the workspace root, `""`, where
 * a root `index.md` lives; a folder stored under it is shown at the top level. A legacy note is
 * named after its title. No two folders or notes ever get the same path (letter case ignored):
 * the oldest (first signed write, then ID) keeps a contested name, so a new duplicate never takes
 * an existing note's path; the others get `uniqueName` and are reported. A folder whose parent
 * isn't known shows under the parent's ID.
 */
export function buildWorkspacePaths(
  folders: readonly StoredFolder[],
  notes: readonly StoredNote[],
): WorkspaceLayout {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const root = rootFolderOf(folders)?.id ?? null;
  const folderPaths = new Map<string, string>();
  const taken = new Map<string, Set<string>>();
  const renamed: WorkspaceLayout["renamed"][number][] = [];
  const claim = (parent: string, name: string, id: string): string => {
    const names = taken.get(parent) ?? new Set<string>();
    taken.set(parent, names);
    const unique = uniqueName(name, names, id);
    names.add(foldName(unique));
    return unique;
  };
  const parentPath = (parentId: string | null, seen: Set<string>): string =>
    parentId === null || parentId === root ? "" : pathOf(parentId, seen);
  // parents first, the oldest sibling first, so claims are stable
  const pathOf = (id: string, seen: Set<string> = new Set()): string => {
    const known = folderPaths.get(id);
    if (known !== undefined) return known;
    if (id === root) return "";
    const folder = byId.get(id);
    if (folder === undefined || seen.has(id)) {
      // an unknown or looping parent: shown under its ID at the top level
      const path = claim("", safeSegment(id, "folder"), id);
      folderPaths.set(id, path);
      return path;
    }
    seen.add(id);
    const parent = parentPath(folder.parentId, seen);
    const segment = folderSegment(folder.name, id);
    const name = claim(parent, segment, id);
    if (name !== segment) renamed.push({ id, path: joinPath(parent, name), reason: "duplicate" });
    const path = joinPath(parent, name);
    folderPaths.set(id, path);
    return path;
  };
  if (root !== null) folderPaths.set(root, "");
  for (const folder of [...folders].sort(byAge)) pathOf(folder.id);

  const notePaths = new Map<string, string>();
  for (const note of [...notes].sort(byAge)) {
    const folder = note.folderId === root ? "" : pathOf(note.folderId);
    const wanted =
      note.name === null
        ? noteNameFromTitle(noteTitle(note.text, note.id))
        : usableNoteName(note.name);
    const name = claim(folder, wanted, note.id);
    const path = joinPath(folder, name);
    notePaths.set(note.id, path);
    if (name !== wanted) renamed.push({ id: note.id, path, reason: "duplicate" });
    else if (note.name === null) renamed.push({ id: note.id, path, reason: "legacy" });
    else if (name !== note.name) renamed.push({ id: note.id, path, reason: "invalid" });
  }
  return { folders: folderPaths, notes: notePaths, root, renamed };
}

/** Where an imported bundle's notes go: folders to create (parents first) and named notes. */
export interface ImportPlan {
  /** Every folder, parents first; `path: ""` is the workspace root (created only when needed). */
  readonly folders: readonly {
    readonly path: string;
    readonly parent: string | null;
    readonly name: string;
  }[];
  /** Every note with its folder path and exact file name. */
  readonly notes: readonly {
    readonly path: string;
    readonly folder: string;
    readonly name: string;
    readonly text: string;
  }[];
}

/**
 * Maps an import onto what the sync API stores: each folder as a name under its parent (the
 * root folder, an empty name with no parent, when any note sits at the root) and each note as
 * its folder plus its exact file name, so exporting gives back the same paths.
 */
export function planImport(result: Pick<ImportResult, "notes" | "folders">): ImportPlan {
  const notes = result.notes.map((note) => {
    const path = normalizePath(note.path);
    return {
      path,
      folder: folderOf(path),
      name: normalizeNoteName(fileNameOf(path)),
      text: note.text,
    };
  });
  const paths = new Set<string>();
  for (const folder of result.folders) if (folder !== "") paths.add(normalizePath(folder));
  for (const note of notes) {
    for (let folder = note.folder; folder !== ""; folder = folderOf(folder)) paths.add(folder);
  }
  const needsRoot = notes.some((note) => note.folder === "");
  const folders = [...paths]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .map((path) => {
      const parent = folderOf(path);
      return {
        path,
        // top-level folders have no parent; the root folder only holds root notes
        parent: parent === "" ? null : parent,
        name: fileNameOf(path),
      };
    });
  return {
    folders: needsRoot ? [{ path: "", parent: null, name: "" }, ...folders] : folders,
    notes,
  };
}
