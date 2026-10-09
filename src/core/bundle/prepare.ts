import type { BundleFile } from "./types.js";

/** A bundle file with its path unified (`/` separators) and the bundle's own folder removed. */
export interface PreparedFile {
  /** The path inside the bundle. */
  readonly path: string;
  readonly data: Uint8Array | string;
}

/** The bundle's files ready to sort, with what preparing them changed. */
export interface Prepared {
  readonly files: readonly PreparedFile[];
  /** The shared top folder stripped from every path, if any. */
  readonly root: string | null;
  /** Paths that lost a leading `/`. */
  readonly adjusted: readonly {
    readonly from: string;
    readonly to: string;
    readonly reason: string;
  }[];
}

/** Thrown before any work when a bundle is larger than the import accepts. */
export class ImportLimitError extends Error {
  override readonly name = "ImportLimitError";

  constructor(
    readonly limit: "maxFiles" | "maxBytes",
    readonly allowed: number,
    readonly actual: number,
  ) {
    super(
      `The bundle has ${String(actual)} ${limit === "maxFiles" ? "files" : "bytes"}; the limit is ${String(allowed)}.`,
    );
  }
}

export const DEFAULT_MAX_FILES = 50_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

/** Refuses a bundle over the file count or size limits. Text counts one byte per UTF-16 unit. */
export function checkLimits(
  files: readonly BundleFile[],
  limits: { readonly maxFiles?: number; readonly maxBytes?: number },
): void {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  if (files.length > maxFiles) throw new ImportLimitError("maxFiles", maxFiles, files.length);
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  let bytes = 0;
  for (const file of files) {
    bytes += file.data.length;
    if (bytes > maxBytes) throw new ImportLimitError("maxBytes", maxBytes, bytes);
  }
}

/** Whether a root-level path marks a bundle: an OKF index or log, or Obsidian's settings. */
function isMarker(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "index.md" || lower === "log.md" || path.startsWith(".obsidian/");
}

/**
 * Unifies separators (a leading `./` goes; a leading `/` goes and is reported) and, when
 * `stripRoot` is on, removes a top folder every path shares, but only when that folder holds the
 * bundle's markers: a folder picker's `MyVault/...` or a zip of the folder, never a plain folder
 * the person meant to import as a folder.
 */
export function prepareFiles(files: readonly BundleFile[], stripRoot: boolean): Prepared {
  const adjusted: { from: string; to: string; reason: string }[] = [];
  const unified = files.map((file) => {
    let path = file.path.replace(/\\/g, "/");
    while (path.startsWith("./")) path = path.slice(2);
    if (path.startsWith("/")) {
      const trimmed = path.replace(/^\/+/, "");
      adjusted.push({ from: file.path, to: trimmed, reason: "A leading / was removed." });
      path = trimmed;
    }
    return { path, data: file.data };
  });
  const first = unified[0]?.path.split("/")[0];
  const shared =
    stripRoot &&
    first !== undefined &&
    first !== "" &&
    !first.startsWith(".") &&
    unified.every((file) => file.path.startsWith(`${first}/`));
  if (!shared) return { files: unified, root: null, adjusted };
  const stripped = unified.map((file) => ({ ...file, path: file.path.slice(first.length + 1) }));
  return stripped.some((file) => isMarker(file.path))
    ? { files: stripped, root: first, adjusted }
    : { files: unified, root: null, adjusted };
}
