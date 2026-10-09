import { fileNameOf, folderChain, folderOf } from "../path/index.js";
import type { Folder, Note } from "./types.js";

interface MutableFolder {
  path: string;
  folders: Set<string>;
  notes: Note[];
}

/** Builds the folder tree from note folders plus extra (possibly empty) folder paths. */
export function buildFolders(
  notes: Iterable<Note>,
  extraFolders: readonly string[],
): Map<string, Folder> {
  const draft = new Map<string, MutableFolder>();
  const ensure = (path: string): MutableFolder => {
    let folder = draft.get(path);
    if (folder === undefined) {
      folder = { path, folders: new Set(), notes: [] };
      draft.set(path, folder);
      if (path !== "") ensure(folderOf(path)).folders.add(path);
    }
    return folder;
  };
  ensure("");
  for (const path of extraFolders) for (const folder of folderChain(path)) ensure(folder);
  for (const note of notes) ensure(note.folder).notes.push(note);

  const folders = new Map<string, Folder>();
  for (const { path, folders: children, notes: inFolder } of draft.values()) {
    inFolder.sort((a, b) => a.path.localeCompare(b.path));
    folders.set(path, {
      path,
      name: path === "" ? "" : fileNameOf(path),
      parent: path === "" ? null : folderOf(path),
      folders: [...children].sort((a, b) => a.localeCompare(b)),
      notes: inFolder.map((note) => note.id),
      index: inFolder.find((note) => note.role === "index")?.id ?? null,
      log: inFolder.find((note) => note.role === "log")?.id ?? null,
    });
  }
  return folders;
}
