import {
  extensionOf,
  fileNameOf,
  folderOf,
  InvalidPathError,
  joinPath,
  normalizePath,
} from "../path/index.js";
import { foldName } from "./layout.js";
import { MAX_NOTE_NAME_BYTES, utf8Length } from "./note-file.js";

/**
 * Normalizes an attachment's file name with the workspace path rules (`normalizePath`): one
 * segment (no folder part), not a note (`.md` is a note's), at most 255 UTF-8 bytes. Throws
 * `InvalidPathError` otherwise. Names are unique per folder, letter case ignored
 * (`attachmentKey`).
 */
export function normalizeAttachmentName(name: string): string {
  const normalized = normalizePath(name);
  if (normalized === "") throw new InvalidPathError(name, "an attachment needs a file name");
  if (normalized.includes("/")) {
    throw new InvalidPathError(name, "an attachment name can't hold a folder (`/`)");
  }
  if (extensionOf(normalized) === ".md") {
    throw new InvalidPathError(name, "a `.md` file is a note, not an attachment");
  }
  if (utf8Length(normalized) > MAX_NOTE_NAME_BYTES) {
    throw new InvalidPathError(name, `a file name is at most ${String(MAX_NOTE_NAME_BYTES)} bytes`);
  }
  return normalized;
}

/**
 * Where an asset link's resolved path (`resolveLink`'s `{ status: "asset", path }`) points: the
 * folder path and the file name, to find the attachment by its folder and name.
 */
export function assetLocation(path: string): { readonly folder: string; readonly name: string } {
  const normalized = normalizePath(path);
  return { folder: folderOf(normalized), name: fileNameOf(normalized) };
}

/**
 * The lookup key of an attachment at a folder path and name, letter case ignored the way a
 * case-insensitive file system would (`foldName`): the same for an asset link's path
 * (`attachmentKey(assetLocation(path))`) and for a stored attachment (its folder's path and name).
 */
export function attachmentKey(location: {
  readonly folder: string;
  readonly name: string;
}): string {
  return foldName(joinPath(location.folder, location.name));
}
