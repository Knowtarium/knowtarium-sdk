/**
 * Workspace paths. A note's path is a plain string relative to the workspace root, with forward
 * slashes (`research/pricing.md`); the root folder is the empty string. Core never touches a file
 * system, so these helpers only guard the strings an import or an agent hands us.
 */

/** Thrown by `normalizePath` for a path that could escape the workspace or is not a plain path. */
export class InvalidPathError extends Error {
  override readonly name = "InvalidPathError";

  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Invalid workspace path ${JSON.stringify(path)}: ${reason}`);
  }
}

// C0 and C1 controls, and the bidirectional overrides and isolates that can disguise a name
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
// names Windows refuses whatever their extension, so an export can always be unpacked there
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function segmentProblem(segment: string): string | null {
  if (segment === "..") return "`..` segments are not allowed";
  if (/[. ]$/.test(segment)) return "a name can't end in a dot or a space";
  if (WINDOWS_RESERVED.test(segment)) return `${segment} is a reserved name on Windows`;
  return null;
}

/**
 * Normalizes a workspace-relative path: Unicode NFC, backslashes become slashes, empty and `.`
 * segments go. Refuses absolute paths, `:` anywhere (drive letters, alternate streams, URLs),
 * `..` segments, control characters, bidirectional overrides, names ending in a dot or a space
 * and Windows reserved names, so an import or an agent can't create paths that escape the
 * workspace, disguise themselves or fail to export. Returns `""` for the root.
 */
export function normalizePath(path: string): string {
  const unified = path.normalize("NFC").replace(/\\/g, "/");
  if (unified.startsWith("/")) throw new InvalidPathError(path, "absolute paths are not allowed");
  if (unified.includes(":")) throw new InvalidPathError(path, "`:` is not allowed in a path");
  if (FORBIDDEN_CHARACTER.test(unified)) {
    throw new InvalidPathError(path, "control and bidirectional characters are not allowed");
  }
  const segments = unified.split("/").filter((segment) => segment !== "" && segment !== ".");
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== null) throw new InvalidPathError(path, problem);
  }
  return segments.join("/");
}

/** The folder part of a normalized path (`""` for a note at the root). */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The last segment of a normalized path. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The file name without its last extension (`pricing.md` gives `pricing`). */
export function stemOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The lowercased last extension including the dot (`.md`), or `""`. */
export function extensionOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Joins normalized segments, skipping empty ones (so joining onto the root folder works). */
export function joinPath(...parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("/");
}

/**
 * Resolves a relative reference (as written in a link) against a folder, applying `.` and `..`.
 * Returns `null` when the reference climbs above the workspace root.
 */
export function resolveRelative(folder: string, reference: string): string | null {
  const segments = folder === "" ? [] : folder.split("/");
  for (const segment of reference.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/** The folder and all its ancestors, from the root down (`a/b` gives `""`, `a`, `a/b`). */
export function folderChain(folder: string): string[] {
  const chain = [""];
  if (folder === "") return chain;
  const segments = folder.split("/");
  for (let i = 1; i <= segments.length; i++) chain.push(segments.slice(0, i).join("/"));
  return chain;
}
