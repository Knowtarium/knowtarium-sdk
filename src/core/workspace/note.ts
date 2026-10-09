import { parseLinks } from "../links/parse.js";
import { parseNote } from "../note/parse.js";
import type { NoteProblem } from "../note/types.js";
import {
  extensionOf,
  fileNameOf,
  folderOf,
  InvalidPathError,
  normalizePath,
  stemOf,
} from "../path/index.js";
import { validateFrontmatter } from "../schema/validate.js";
import { isReservedFile } from "../spec.js";
import type { Note, NoteInput, NoteRole } from "./types.js";

function roleOf(path: string): NoteRole {
  if (!isReservedFile(path)) return "note";
  return fileNameOf(path) === "index.md" ? "index" : "log";
}

/**
 * Parses and validates one note. Throws `InvalidPathError` for a path that isn't a normalizable
 * `.md` path; problems inside the note are reported on it, never thrown.
 */
export function createNote(input: NoteInput): Note {
  const path = normalizePath(input.path);
  if (path === "" || extensionOf(path) !== ".md") {
    throw new InvalidPathError(input.path, "a note's path must end in .md");
  }
  const parsed = parseNote(input.text);
  const frontmatter = parsed.frontmatter?.data ?? {};
  const validation = validateFrontmatter(frontmatter);
  const fieldProblems: NoteProblem[] = validation.problems.map((problem) => ({
    code: "field-invalid",
    field: problem.field,
    message: `${problem.field}: ${problem.message}`,
  }));
  const fileName = fileNameOf(path);
  const title = validation.fields.title?.trim();
  return {
    id: input.id,
    path,
    folder: folderOf(path),
    fileName,
    role: roleOf(path),
    title: title === undefined || title === "" ? stemOf(path) : title,
    parsed,
    frontmatter,
    fields: validation.fields,
    body: parsed.body,
    problems: [...parsed.problems, ...fieldProblems],
    linkRefs: parseLinks(parsed.body, parsed.bodyLine),
  };
}
