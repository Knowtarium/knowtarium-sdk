import { folderChain, folderOf } from "../path/index.js";
import { isNotePath, tryNormalize } from "./files.js";
import type { PreparedFile } from "./prepare.js";

/** A file of the bundle that passed the path checks. */
export interface CollectedFile {
  /** The path as given (after `prepareFiles`). */
  readonly raw: string;
  /** Its normalized path. */
  readonly path: string;
  readonly data: Uint8Array | string;
  readonly kind: "note" | "attachment";
}

/** The bundle's files sorted out: kept, skipped (with why), in conflict, and folders. */
export interface Collected {
  readonly files: CollectedFile[];
  readonly folders: Set<string>;
  readonly skipped: { path: string; reason: string }[];
  readonly conflicts: { path: string; reason: string; paths?: string[] }[];
}

/** The folders on a path, root excluded (`a/b/c.md` gives `a`, `a/b`). */
function foldersOf(path: string): string[] {
  return folderChain(folderOf(path)).filter((folder) => folder !== "");
}

/**
 * Sorts a bundle's files: `skip` names files to leave out (with the reason), every other path is
 * normalized with core's rules (a path that fails is a conflict: the import never invents a new
 * name). Paths that would collide on a case-insensitive file system are conflicts too, all of
 * them left out: two files, two folders whose names differ only in letter case, or a file with the
 * same name as a folder. A path ending in `/` is an (empty) folder.
 */
export function collect(
  input: readonly PreparedFile[],
  skip: (path: string) => string | null,
): Collected {
  const result: Collected = { files: [], folders: new Set([""]), skipped: [], conflicts: [] };
  const candidates: CollectedFile[] = [];
  const emptyFolders: string[] = [];
  for (const file of input) {
    if (file.path === "") continue;
    const reason = skip(file.path);
    if (reason !== null) {
      result.skipped.push({ path: file.path, reason });
      continue;
    }
    const normalized = tryNormalize(file.path);
    if ("problem" in normalized) {
      result.conflicts.push({ path: file.path, reason: normalized.problem });
      continue;
    }
    if (file.path.endsWith("/")) {
      if (normalized.path !== "") emptyFolders.push(normalized.path);
      continue;
    }
    candidates.push({
      raw: file.path,
      path: normalized.path,
      data: file.data,
      kind: isNotePath(normalized.path) ? "note" : "attachment",
    });
  }

  // every spelling of every folder, by its case-folded path
  const spellings = new Map<string, Set<string>>();
  for (const folder of [
    ...candidates.flatMap((file) => foldersOf(file.path)),
    ...emptyFolders.flatMap((folder) => folderChain(folder).filter((f) => f !== "")),
  ]) {
    const folded = folder.toLowerCase();
    spellings.set(folded, (spellings.get(folded) ?? new Set()).add(folder));
  }
  const filePaths = new Set(candidates.map((file) => file.path.toLowerCase()));
  const byFolded = new Map<string, CollectedFile[]>();
  for (const file of candidates) {
    const folded = file.path.toLowerCase();
    const clash = foldersOf(file.path).find(
      (folder) => (spellings.get(folder.toLowerCase())?.size ?? 0) > 1,
    );
    if (clash !== undefined) {
      result.conflicts.push({
        path: file.raw,
        reason: "Its folder has the same name as another one, differing only in letter case.",
        paths: [...(spellings.get(clash.toLowerCase()) ?? [])],
      });
      continue;
    }
    const sameAsFolder = spellings.get(folded);
    if (sameAsFolder !== undefined) {
      result.conflicts.push({
        path: file.raw,
        reason: "A folder has the same name as this file.",
        paths: [file.path, ...sameAsFolder],
      });
      continue;
    }
    const underFile = foldersOf(file.path).find((folder) => filePaths.has(folder.toLowerCase()));
    if (underFile !== undefined) {
      result.conflicts.push({
        path: file.raw,
        reason: "Its folder has the same name as a file.",
        paths: [underFile, file.path],
      });
      continue;
    }
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), file]);
  }
  for (const group of byFolded.values()) {
    const [only] = group;
    if (group.length === 1 && only !== undefined) {
      result.files.push(only);
      for (const folder of folderChain(folderOf(only.path))) result.folders.add(folder);
    } else {
      for (const file of group) {
        result.conflicts.push({
          path: file.raw,
          reason:
            "Another file has the same path (letters differing only in case count as the same).",
          paths: group.map((other) => other.raw),
        });
      }
    }
  }
  for (const folder of emptyFolders) {
    if ((spellings.get(folder.toLowerCase())?.size ?? 0) > 1) continue;
    for (const chain of folderChain(folder)) result.folders.add(chain);
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

/** Folders sorted so parents come before children. */
export function sortedFolders(folders: Iterable<string>): string[] {
  return [...folders].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}
