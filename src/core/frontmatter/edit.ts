// The shared machinery of every frontmatter edit: find the top-level mapping, splice new text into
// the YAML source, re-parse, and check the result. Notes are never re-serialized from an object.
import { isMap, isScalar, type Pair, type YAMLMap } from "yaml";

import { documentOf } from "../note/document.js";
import { parseNote } from "../note/parse.js";
import type { LineEnding, ParsedNote } from "../note/types.js";
import { sameExcept } from "./equal.js";
import { FrontmatterEditError } from "./errors.js";
import { applySplices, columnOf, rangeOf, type Splice } from "./source.js";

/** What an edit works on: the note, its YAML source and its top-level mapping. */
export interface EditContext {
  readonly note: ParsedNote;
  readonly source: string;
  readonly eol: LineEnding;
  /** `null` for empty frontmatter. */
  readonly map: YAMLMap | null;
  /** The indentation of top-level keys. */
  readonly indent: string;
}

/** Gives a note an empty frontmatter block when it has none. */
function withFrontmatter(note: ParsedNote): ParsedNote {
  if (note.frontmatter !== null) return note;
  if (note.problems.some((problem) => problem.code === "frontmatter-unclosed")) {
    throw new FrontmatterEditError(
      "The note's frontmatter is never closed; fix it before editing.",
    );
  }
  const { eol } = note;
  const prefix = note.text.slice(0, note.bodyOffset); // a byte order mark, if any
  return parseNote(`${prefix}---${eol}---${eol}${note.body}`);
}

/** Opens a note for a frontmatter edit, refusing frontmatter that doesn't parse cleanly. */
export function openForEdit(note: ParsedNote): EditContext {
  const target = withFrontmatter(note);
  const frontmatter = target.frontmatter;
  if (frontmatter === null) throw new FrontmatterEditError("The note has no frontmatter.");
  const { source } = frontmatter;
  const document = documentOf(frontmatter);
  if (document.errors.length > 0) {
    throw new FrontmatterEditError(
      "The note's frontmatter is not valid YAML; fix it before editing.",
    );
  }
  const contents = document.contents;
  let map: YAMLMap | null = null;
  if (contents !== null) {
    if (!isMap(contents) || source[rangeOf(contents)[0]] === "{") {
      throw new FrontmatterEditError("The frontmatter must be a block of `key: value` fields.");
    }
    map = contents;
  }
  const first = map?.items[0];
  const indent = first === undefined ? "" : " ".repeat(columnOf(source, rangeOf(first.key)[0]));
  return { note: target, source, eol: target.eol, map, indent };
}

/** The top-level pair for a key, if the frontmatter has it. */
export function findPair(map: YAMLMap | null, key: string): Pair | undefined {
  return map?.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

/** The splice that adds a new top-level `key: value` (or `key:` plus a block) at the end. */
export function appendPair(context: EditContext, key: string, valueText: string): Splice {
  const { source, eol, indent } = context;
  const needsBreak = source !== "" && !source.endsWith("\n");
  const block = valueText.startsWith(eol);
  const line = `${indent}${key}:${block ? "" : " "}${valueText}${eol}`;
  return { start: source.length, end: source.length, text: needsBreak ? eol + line : line };
}

/**
 * Applies splices to the frontmatter and re-parses the note. The result must parse cleanly, every
 * top-level field other than `edited` must read back exactly as before (which catches an edit
 * leaking through a YAML alias or merge key), and `check` must confirm the edited value. A failure
 * throws and writes nothing.
 */
export function commit(
  context: EditContext,
  splices: readonly Splice[],
  edited: readonly string[],
  check: (data: Readonly<Record<string, unknown>>) => boolean,
): ParsedNote {
  const { note, source } = context;
  const frontmatter = note.frontmatter;
  if (frontmatter === null) throw new FrontmatterEditError("The note has no frontmatter.");
  const yaml = applySplices(source, splices);
  const text =
    note.text.slice(0, frontmatter.offset) +
    yaml +
    note.text.slice(frontmatter.offset + source.length);
  const result = parseNote(text);
  const after = result.frontmatter;
  if (result.problems.length > 0 || after === null) {
    throw new FrontmatterEditError("The edit did not produce valid frontmatter.");
  }
  if (!sameExcept(frontmatter.data, after.data, edited)) {
    throw new FrontmatterEditError(
      "The edit would change other fields too (through a YAML alias or merge key); edit it by hand.",
    );
  }
  if (!check(after.data)) {
    throw new FrontmatterEditError("The edit did not produce the expected frontmatter.");
  }
  return result;
}
