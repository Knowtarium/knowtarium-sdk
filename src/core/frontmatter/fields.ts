// Edits of top-level OKF fields the app changes directly: scalars (title, description, type,
// status, stale_after) and string lists (tags). Each edit touches only that field's value.
import { isScalar, isSeq, type Pair } from "yaml";

import type { ParsedNote } from "../note/types.js";
import { formatTimestamp } from "./actor.js";
import { appendPair, commit, findPair, openForEdit } from "./edit.js";
import { FrontmatterEditError } from "./errors.js";
import { spliceBlockList, spliceFlowList } from "./list.js";
import { renderScalar, type ScalarValue } from "./scalar.js";
import {
  isFlowCollection,
  lineEndAfter,
  lineStart,
  rangeOf,
  replaceValue,
  type Splice,
} from "./source.js";

function assertKey(key: string): void {
  if (!/^[A-Za-z_][\w-]*$/.test(key)) {
    throw new FrontmatterEditError(`${JSON.stringify(key)} is not a field name the edits write`);
  }
}

/**
 * Sets a top-level field to a scalar. An existing scalar keeps its position, trailing comment and
 * quoting style; a missing field is added at the end of the frontmatter.
 */
export function setField(note: ParsedNote, key: string, value: ScalarValue): ParsedNote {
  assertKey(key);
  const context = openForEdit(note);
  const pair = findPair(context.map, key);
  const style = pair !== undefined && isScalar(pair.value) ? pair.value.type : undefined;
  const text = renderScalar(value, { style });
  const splice =
    pair === undefined ? appendPair(context, key, text) : replaceValue(context.source, pair, text);
  return commit(context, [splice], [key], (data) => data[key] === value);
}

/** The splice that deletes a top-level pair's lines (from its key to the end of its value). */
export function removePair(source: string, pair: Pair): Splice {
  const [keyStart] = rangeOf(pair.key);
  const valueEnd = pair.value === null ? keyStart : rangeOf(pair.value)[1];
  return {
    start: lineStart(source, keyStart),
    end: lineEndAfter(source, Math.max(valueEnd, keyStart + 1)),
    text: "",
  };
}

/** Removes a top-level field. Other lines, including comments around it, stay. */
export function removeField(note: ParsedNote, key: string): ParsedNote {
  const context = openForEdit(note);
  const pair = findPair(context.map, key);
  if (pair === undefined) return note;
  return commit(
    context,
    [removePair(context.source, pair)],
    [key],
    (data) => !Object.hasOwn(data, key),
  );
}

/**
 * Sets a top-level field to a list of strings, item by item: unchanged items keep their lines,
 * quoting and comments. A flow list (`[a, b]`) stays a flow list and a block list keeps its
 * indentation; a missing or scalar field becomes a block list, and an empty list is written `[]`.
 */
export function setStringList(
  note: ParsedNote,
  key: string,
  values: readonly string[],
): ParsedNote {
  assertKey(key);
  const context = openForEdit(note);
  const { source, eol } = context;
  const pair = findPair(context.map, key);
  const current = pair?.value;
  let splice: Splice;
  if (pair !== undefined && isSeq(current) && isFlowCollection(source, current)) {
    splice = spliceFlowList(source, current, values);
  } else if (
    pair !== undefined &&
    isSeq(current) &&
    current.items.length > 0 &&
    values.length > 0
  ) {
    splice = spliceBlockList(source, current, values, eol);
  } else if (values.length === 0) {
    splice = pair === undefined ? appendPair(context, key, "[]") : replaceValue(source, pair, "[]");
  } else {
    const dash = " ".repeat(context.indent.length + 2);
    const text = eol + values.map((value) => `${dash}- ${renderScalar(value)}`).join(eol);
    splice = pair === undefined ? appendPair(context, key, text) : replaceValue(source, pair, text);
  }
  return commit(context, [splice], [key], (data) => {
    const list = data[key];
    return (
      Array.isArray(list) &&
      list.length === values.length &&
      list.every((item, i) => item === values[i])
    );
  });
}

/** Sets the note's `title`. */
export function setTitle(note: ParsedNote, title: string): ParsedNote {
  return setField(note, "title", title);
}

/** Sets the note's `description`. */
export function setDescription(note: ParsedNote, description: string): ParsedNote {
  return setField(note, "description", description);
}

/** Sets the note's OKF `type` (any string: unknown types are allowed). */
export function setType(note: ParsedNote, type: string): ParsedNote {
  return setField(note, "type", type);
}

/** Sets the note's `status`. */
export function setStatus(note: ParsedNote, status: string): ParsedNote {
  return setField(note, "status", status);
}

/** Sets `stale_after` to a date-time, or removes it with `null`. */
export function setStaleAfter(note: ParsedNote, at: Date | string | null): ParsedNote {
  return at === null
    ? removeField(note, "stale_after")
    : setField(note, "stale_after", formatTimestamp(at));
}

/** Sets the note's `tags`. */
export function setTags(note: ParsedNote, tags: readonly string[]): ParsedNote {
  return setStringList(note, "tags", tags);
}
