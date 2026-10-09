import { extensionOf, InvalidPathError, normalizePath } from "../path/index.js";

/** The UTF-8 decoder, typed by hand: `src/` has neither DOM nor Node types on purpose. */
interface Utf8Decoder {
  decode(input: Uint8Array): string;
}
const Decoder = (
  globalThis as unknown as {
    TextDecoder: new (
      label: "utf-8",
      options: { fatal: boolean; ignoreBOM: boolean },
    ) => Utf8Decoder;
  }
).TextDecoder;

/**
 * A file's text, strictly UTF-8 (a byte order mark is kept, as the note parser expects); null
 * when the bytes aren't UTF-8.
 */
export function fileText(data: Uint8Array | string): string | null {
  if (typeof data === "string") return data;
  try {
    return new Decoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return null;
  }
}

/** Whether a path is a markdown note. */
export function isNotePath(path: string): boolean {
  return extensionOf(path) === ".md";
}

/** Whether any segment of a raw path is hidden (starts with a dot). */
export function isHidden(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

/** The normalized path, or the reason it can't be one. */
export function tryNormalize(path: string): { path: string } | { problem: string } {
  try {
    return { path: normalizePath(path) };
  } catch (error) {
    if (error instanceof InvalidPathError) return { problem: error.message };
    throw error;
  }
}

/** A path relative to `fromFolder`, for a markdown link (`../assets/chart.png`). */
export function relativePath(fromFolder: string, to: string): string {
  const from = fromFolder === "" ? [] : fromFolder.split("/");
  const target = to.split("/");
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) {
    common++;
  }
  return [...from.slice(common).map(() => ".."), ...target.slice(common)].join("/");
}

/**
 * A path as a markdown link destination: percent-encoded where markdown or URLs would misread it
 * (spaces become `%20`, as Obsidian writes them), slashes kept.
 */
export function linkDestination(path: string): string {
  return encodeURI(path)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
}
