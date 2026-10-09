import { FrontmatterEditError } from "../frontmatter/errors.js";
import { fileNameOf, folderChain, folderOf, joinPath, normalizePath } from "../path/index.js";
import type { NoteInput, Workspace } from "../workspace/index.js";
import { sortedFolders } from "./collect.js";
import { folderIndex, foldersWithIndex } from "./indexes.js";
import type { BundleFile } from "./types.js";
import {
  type ConfirmedEntry,
  type UnconfirmedHumanEntries,
  withoutUnconfirmedHumanEntries,
} from "./unconfirmed.js";

/** What an export holds: notes (decrypted), attachments, empty folders and optionally old versions. */
export interface ExportInput {
  /** The notes, or a workspace built from them. */
  readonly notes: Iterable<NoteInput> | Workspace;
  readonly attachments?: readonly { readonly path: string; readonly data: Uint8Array | string }[];
  /** Folders to include even when empty. */
  readonly folders?: readonly string[];
  /** Past versions to include, per note path. */
  readonly history?: readonly {
    readonly path: string;
    readonly versions: readonly { readonly version: number; readonly text: string }[];
  }[];
}

export interface ExportOptions {
  /** Export only this folder (paths in the bundle are then relative to it). Default: everything. */
  readonly folder?: string;
  /** Write an `index.md` in every folder that has none. Default true. */
  readonly addMissingIndexes?: boolean;
  /** The heading of a generated root `index.md`. Default `Index`. */
  readonly name?: string;
  /**
   * Exporting from the app, where signed writes confirm `human:` entries: the confirmed entries per
   * note path (as given in `notes`). When set, every other `human:` entry in the exported notes
   * and their past versions is stripped (`unconfirmedHumanEntries: "strip"`, the default) or moved
   * to an `unconfirmed_verified` list (`"annotate"`), so a plain OKF reader of the bundle never
   * trusts an entry no signature backs. Leave it out for plain OKF bundles (no signed events).
   */
  readonly confirmedHumanEntries?: ReadonlyMap<string, readonly ConfirmedEntry[]>;
  readonly unconfirmedHumanEntries?: UnconfirmedHumanEntries;
}

/** A bundle ready to zip: files (paths relative to the bundle root) and every folder. */
export interface ExportedBundle {
  readonly files: readonly BundleFile[];
  /** Every folder, empty ones included, parents first (`""` is the root). */
  readonly folders: readonly string[];
  /** The files the export wrote (generated `index.md` files). */
  readonly generated: readonly string[];
  /**
   * Notes (or past versions, `version` set) left out of the bundle because their unconfirmed
   * `human:` entries couldn't be removed (a YAML anchor `verified` shares with another field):
   * paths as in the bundle, with the reason. Only when `confirmedHumanEntries` is set.
   */
  readonly withheld: readonly WithheldNote[];
}

/** A note or past version the export left out, and why. */
export interface WithheldNote {
  readonly path: string;
  /** The past version, or null for the note itself. */
  readonly version: number | null;
  readonly reason: string;
}

/** Where past versions go: a hidden folder OKF readers and the import both leave out. */
export const HISTORY_FOLDER = ".knowtarium/history";

function isWorkspace(notes: ExportInput["notes"]): notes is Workspace {
  return (notes as Workspace).notes instanceof Map;
}

function scoped(path: string, folder: string): string | null {
  if (folder === "") return path;
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : null;
}

/**
 * Exports a workspace as an OKF bundle, as a list of files the caller zips (core has no zip
 * library): every note byte for byte at its path, attachments as given, an `index.md` in every
 * folder that lacks one, and past versions under `.knowtarium/history/<note path>/<version>.md`
 * when given. A bundle exported and imported again gives the same notes byte for byte. With
 * `confirmedHumanEntries`, a note whose unconfirmed entries can't be removed is left out and listed
 * in `withheld` instead of stopping the whole export.
 */
export function exportBundle(input: ExportInput, options: ExportOptions = {}): ExportedBundle {
  const folder = options.folder === undefined ? "" : normalizePath(options.folder);
  const notes = isWorkspace(input.notes)
    ? [...input.notes.notes.values()].map((note) => ({ path: note.path, text: note.parsed.text }))
    : [...input.notes].map((note) => ({ path: normalizePath(note.path), text: note.text }));
  const confirmed = options.confirmedHumanEntries;
  const mode = options.unconfirmedHumanEntries ?? "strip";
  const withheld: WithheldNote[] = [];
  /** The text to export, or null when it can't be cleaned (withheld; one note never stops all). */
  const clean = (
    path: string,
    text: string,
    where: { readonly path: string; readonly version: number | null },
  ): string | null => {
    if (confirmed === undefined) return text;
    try {
      return withoutUnconfirmedHumanEntries(text, confirmed.get(path) ?? [], mode);
    } catch (error) {
      if (!(error instanceof FrontmatterEditError)) throw error;
      withheld.push({ ...where, reason: error.message });
      return null;
    }
  };
  const files: BundleFile[] = [];
  const folders = new Set<string>([""]);
  const addFolders = (path: string) => {
    for (const chain of folderChain(folderOf(path))) folders.add(chain);
  };
  const exported: { path: string; text: string }[] = [];
  for (const note of notes) {
    const path = scoped(note.path, folder);
    if (path === null) continue;
    const text = clean(note.path, note.text, { path, version: null });
    if (text === null) continue;
    exported.push({ path, text });
    files.push({ path, data: text });
    addFolders(path);
  }
  for (const attachment of input.attachments ?? []) {
    const path = scoped(normalizePath(attachment.path), folder);
    if (path === null) continue;
    files.push({ path, data: attachment.data });
    addFolders(path);
  }
  for (const extra of input.folders ?? []) {
    const path = scoped(normalizePath(extra), folder);
    if (path === null || path === "") continue;
    for (const chain of folderChain(path)) folders.add(chain);
  }
  const generated: string[] = [];
  if (options.addMissingIndexes ?? true) {
    const taken = new Set(files.map((file) => file.path.toLowerCase()));
    const all = sortedFolders(
      foldersWithIndex(
        [...folders],
        exported.map((note) => note.path),
      ),
    );
    const children = new Map<string, string[]>();
    for (const folder of all) {
      if (folder !== "")
        children.set(folderOf(folder), [...(children.get(folderOf(folder)) ?? []), folder]);
    }
    const byFolder = new Map<string, { path: string; text: string }[]>();
    for (const note of exported) {
      byFolder.set(folderOf(note.path), [...(byFolder.get(folderOf(note.path)) ?? []), note]);
    }
    for (const current of all) {
      const path = joinPath(current, "index.md");
      if (taken.has(path.toLowerCase())) continue;
      const heading = current === "" ? (options.name ?? "Index") : fileNameOf(current);
      files.push({
        path,
        data: folderIndex(
          current,
          byFolder.get(current) ?? [],
          children.get(current) ?? [],
          heading,
        ),
      });
      generated.push(path);
    }
  }
  for (const note of input.history ?? []) {
    const path = scoped(normalizePath(note.path), folder);
    if (path === null) continue;
    const base = joinPath(HISTORY_FOLDER, path.replace(/\.md$/i, ""));
    for (const version of note.versions) {
      const data = clean(normalizePath(note.path), version.text, {
        path,
        version: version.version,
      });
      if (data === null) continue;
      files.push({ path: joinPath(base, `${String(version.version)}.md`), data });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, folders: sortedFolders(folders), generated, withheld };
}
