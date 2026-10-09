import { extensionOf, InvalidPathError, normalizePath } from "../path/index.js";

/**
 * The note file format inside a note's ciphertext. The sync server stores one encrypted blob per
 * note version and nothing readable, so the file name travels inside it, next to the raw OKF
 * text: the plaintext is canonical JSON `{"name":"pricing.md","text":"---\n...","v":1}`. `name`
 * is the file name within the note's folder (folders carry their own encrypted names), so a
 * rename or a move is an ordinary signed write.
 */
export const NOTE_FILE_VERSION = 1;

/** The longest note file name, in UTF-8 bytes (what file systems allow). */
export const MAX_NOTE_NAME_BYTES = 255;

/** The UTF-8 length of a string, in bytes (core has no `TextEncoder` type). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** A note file: its name within its folder and its raw OKF text. */
export interface NoteFile {
  readonly name: string;
  readonly text: string;
}

/** A decrypted note: its file name within its folder and its text. */
export interface NoteContent {
  readonly name: string;
  readonly text: string;
}

/** Thrown for a note file this version can't read: an unknown format version or a bad name. */
export class NoteFileError extends Error {
  override readonly name = "NoteFileError";
}

/**
 * Normalizes a note file name with the workspace path rules (`normalizePath`): one segment (no
 * folder part), a `.md` file, at most 255 UTF-8 bytes. Throws `InvalidPathError` otherwise.
 */
export function normalizeNoteName(name: string): string {
  const normalized = normalizePath(name);
  if (normalized === "") throw new InvalidPathError(name, "a note needs a file name");
  if (normalized.includes("/")) {
    throw new InvalidPathError(name, "a note name can't hold a folder (`/`)");
  }
  if (extensionOf(normalized) !== ".md") {
    throw new InvalidPathError(name, "a note's file name ends in `.md`");
  }
  if (utf8Length(normalized) > MAX_NOTE_NAME_BYTES) {
    throw new InvalidPathError(name, `a file name is at most ${String(MAX_NOTE_NAME_BYTES)} bytes`);
  }
  return normalized;
}

/** The plaintext of a note version: canonical JSON (sorted keys, no spaces). */
export function encodeNoteFile(file: NoteFile): string {
  const name = normalizeNoteName(file.name);
  return `{"name":${JSON.stringify(name)},"text":${JSON.stringify(file.text)},"v":${String(NOTE_FILE_VERSION)}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a note file's plaintext. It must be exactly what `encodeNoteFile` writes (canonical: the
 * same keys in the same order, no spaces, the same escapes), version 1, with a valid, normalized
 * name; else `NoteFileError` (bare text included: every note version stores its name).
 */
export function decodeNoteFile(plaintext: string): NoteContent {
  if (!plaintext.startsWith("{")) throw new NoteFileError("the plaintext isn't a note file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new NoteFileError("the plaintext isn't a note file");
  }
  if (!isRecord(parsed) || !("v" in parsed)) {
    throw new NoteFileError("the plaintext isn't a note file");
  }
  if (parsed["v"] !== NOTE_FILE_VERSION) {
    throw new NoteFileError(
      `note file format ${JSON.stringify(parsed["v"])} is newer than this client reads`,
    );
  }
  const keys = Object.keys(parsed).sort().join(",");
  const { name, text } = parsed;
  if (keys !== "name,text,v" || typeof name !== "string" || typeof text !== "string") {
    throw new NoteFileError("the note file doesn't hold exactly a name and a text");
  }
  let canonical: string;
  try {
    canonical = encodeNoteFile({ name, text });
  } catch (error) {
    throw new NoteFileError(
      `the note file's name is invalid: ${error instanceof Error ? error.message : ""}`,
    );
  }
  if (canonical !== plaintext) {
    throw new NoteFileError("the note file isn't in canonical form (or its name isn't normalized)");
  }
  return { name, text };
}
