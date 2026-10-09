import { formatTimestamp } from "../frontmatter/index.js";
import { parseNote } from "../note/index.js";
import { fileNameOf, folderOf, stemOf } from "../path/index.js";
import { isReservedFile } from "../spec.js";
import { linkDestination } from "./files.js";

/** A note to list in an index: its path and text. */
export interface IndexedNote {
  readonly path: string;
  readonly text: string;
}

function oneLine(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.replace(/\s+/g, " ").trim()
    : null;
}

function escapeText(text: string): string {
  return text.replace(/([[\]\\])/g, "\\$1");
}

/**
 * The folders that get an `index.md`: those that already have one, have notes, or have a
 * subfolder that gets one. A folder holding only attachments gets none (it has nothing to list).
 */
export function foldersWithIndex(
  folders: readonly string[],
  notePaths: readonly string[],
): Set<string> {
  const result = new Set<string>([""]);
  const deepestFirst = [...folders].sort((a, b) => b.split("/").length - a.split("/").length);
  const withNotes = new Set(notePaths.map((path) => folderOf(path)));
  for (const folder of deepestFirst) {
    if (
      withNotes.has(folder) ||
      [...result].some((other) => other !== "" && folderOf(other) === folder)
    ) {
      result.add(folder);
    }
  }
  return result;
}

/**
 * An OKF `index.md` for a folder: no frontmatter, a heading, then a line per note (title, link,
 * description) and one per subfolder (linking its `index.md`), notes by title and folders by name.
 */
export function folderIndex(
  folder: string,
  notes: readonly IndexedNote[],
  subfolders: readonly string[],
  heading: string,
): string {
  const lines = notes
    .filter((note) => folderOf(note.path) === folder && !isReservedFile(note.path))
    .map((note) => {
      const data = parseNote(note.text).frontmatter?.data ?? {};
      const title = oneLine(data["title"]) ?? stemOf(note.path);
      const description = oneLine(data["description"]);
      const link = `* [${escapeText(title)}](${linkDestination(fileNameOf(note.path))})`;
      return { title, line: description === null ? link : `${link} - ${description}` };
    })
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((entry) => entry.line);
  const folders = [...subfolders]
    .sort((a, b) => fileNameOf(a).localeCompare(fileNameOf(b)))
    .map(
      (sub) => `* [${escapeText(fileNameOf(sub))}](${linkDestination(fileNameOf(sub))}/index.md)`,
    );
  return [`# ${heading}`, "", ...lines, ...folders, ""].join("\n");
}

/** A root `log.md` with one entry, newest-first under a `YYYY-MM-DD` heading. */
export function logWithEntry(at: Date | string, entry: string): string {
  const day = formatTimestamp(at).slice(0, 10);
  return ["# Log", "", `## ${day}`, "", `* ${entry}`, ""].join("\n");
}
