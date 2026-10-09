import { type Document, isAlias, isMap, isNode, isScalar, isSeq, type YAMLSeq } from "yaml";

import { documentOf } from "../note/document.js";
import { parseNote } from "../note/parse.js";
import type { ParsedNote } from "../note/types.js";
import { readTimestamp } from "../time/index.js";
import { actorKind, claimsHuman } from "../trust/provenance.js";
import { type Actor, assertActor, formatTimestamp } from "./actor.js";
import { appendPair, commit, type EditContext, findPair, openForEdit } from "./edit.js";
import { sameExcept } from "./equal.js";
import { removeField, removePair } from "./fields.js";
import { blockEntry, type EntryFields, flowEntry, isSpacedFlow } from "./entry.js";
import { FrontmatterEditError } from "./errors.js";
import {
  applySplices,
  columnOf,
  isFlowCollection,
  lineEndAfter,
  lineStart,
  rangeOf,
  replaceValue,
  type Splice,
} from "./source.js";

const LIST_ITEM_PREFIX = /^[ \t]*-[ \t]+$/;

/** The splice that appends an entry to an existing `verified` list, in the list's own style. */
function appendToList(context: EditContext, list: YAMLSeq, fields: EntryFields): Splice {
  const { source, eol } = context;
  const last = list.items[list.items.length - 1];
  if (isFlowCollection(source, list)) {
    if (last === undefined) {
      const at = rangeOf(list)[0] + 1;
      return { start: at, end: at, text: flowEntry(fields) };
    }
    const at = rangeOf(last)[1];
    const spaced = isMap(last) ? isSpacedFlow(source, last) : true;
    return { start: at, end: at, text: `, ${flowEntry(fields, spaced)}` };
  }
  if (last === undefined) throw new FrontmatterEditError("The `verified` list is empty.");

  const [itemStart, itemEnd] = rangeOf(last);
  let prefix = source.slice(lineStart(source, itemStart), itemStart);
  if (!LIST_ITEM_PREFIX.test(prefix))
    prefix = `${" ".repeat(columnOf(source, rangeOf(list)[0]))}- `;
  const at = lineEndAfter(source, itemEnd);
  const text =
    isMap(last) && !isFlowCollection(source, last)
      ? blockEntry(fields, prefix, " ".repeat(prefix.length), eol)
      : `${prefix}${flowEntry(fields, isMap(last) ? isSpacedFlow(source, last) : true)}`;
  return { start: at, end: at, text: text + eol };
}

/**
 * Adds a check to `verified`: a new `{ by, at }` entry (what kind of check it was belongs in the
 * note's history events, not in the frontmatter) after the existing ones, which stay as they
 * are (older entries are history). The entry follows the list's style: flow or block list, flow
 * or block entries, the same indentation. A missing or empty `verified` becomes a block list.
 * Throws a `FrontmatterEditError` when `verified` holds something other than a list.
 */
export function addVerified(note: ParsedNote, actor: Actor, at: Date | string): ParsedNote {
  const by = assertActor(actor);
  const time = formatTimestamp(at);
  const fields: EntryFields = [
    ["by", by],
    ["at", time],
  ];
  const context = openForEdit(note);
  const pair = findPair(context.map, "verified");
  const newList = `${context.eol}${context.indent}  - ${flowEntry(fields)}`;

  let splice: Splice;
  let before = 0;
  if (pair === undefined) {
    splice = appendPair(context, "verified", newList);
  } else if (isSeq(pair.value)) {
    before = pair.value.items.length;
    splice = appendToList(context, pair.value, fields);
  } else if (pair.value === null || (isScalar(pair.value) && pair.value.value === null)) {
    splice = replaceValue(context.source, pair, newList);
  } else {
    throw new FrontmatterEditError("`verified` must be a list to add an entry to it.");
  }

  return commit(context, [splice], ["verified"], (data) => {
    const verified = data["verified"];
    if (!Array.isArray(verified) || verified.length !== before + 1) return false;
    const added: unknown = verified[before];
    return (
      typeof added === "object" &&
      added !== null &&
      (added as Record<string, unknown>)["by"] === by &&
      (added as Record<string, unknown>)["at"] === time
    );
  });
}

/** A `verified` entry as `removeVerified` shows it to its filter. */
export interface VerifiedEntryFields {
  /**
   * The actor as `readProvenance` reads it (trimmed), or null when the item names none (not a
   * `{ by, at }` map, an empty `by`, or a bare `human:`).
   */
  readonly by: string | null;
  /** The time as written, or null. */
  readonly at: string | null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `verified`'s items as `readProvenance` reads them: a list, or one map as a single entry. */
function verifiedItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : isRecord(value) ? [value] : [];
}

/** One item's fields, read exactly like `readProvenance` (aliases resolved, `by` trimmed). */
function entryFields(item: unknown): VerifiedEntryFields {
  if (!isRecord(item)) return { by: null, at: null };
  const by = item["by"];
  if (typeof by !== "string" || by.trim() === "") return { by: null, at: null };
  // a bare `human:` names no one: unreadable, it never counts
  if (claimsHuman(by) && actorKind(by) !== "human") return { by: null, at: null };
  return { by: by.trim(), at: readTimestamp(item["at"]).raw };
}

/** The precise edit: drops the picked items of a plain YAML list, one item per entry, no aliases. */
function spliceOut(
  note: ParsedNote,
  dropped: readonly boolean[],
  kept: readonly VerifiedEntryFields[],
): ParsedNote | null {
  const context = openForEdit(note);
  const pair = findPair(context.map, "verified");
  const list = pair?.value;
  if (!isSeq(list) || list.items.length !== dropped.length || list.items.some(isAlias)) return null;
  const { source } = context;
  let splices: Splice[];
  if (isFlowCollection(source, list)) {
    const [start, end] = rangeOf(list);
    const texts = list.items
      .filter((_, index) => dropped[index] !== true)
      .map((item) => {
        const [from, to] = rangeOf(item);
        return source.slice(from, to);
      });
    const spaced = source[start + 1] === " ";
    splices = [{ start, end, text: spaced ? `[ ${texts.join(", ")} ]` : `[${texts.join(", ")}]` }];
  } else {
    splices = list.items.flatMap((item, index) => {
      if (dropped[index] !== true) return [];
      const [from, to] = rangeOf(item);
      return [{ start: lineStart(source, from), end: lineEndAfter(source, to), text: "" }];
    });
  }
  const result = commit(context, splices, ["verified"], (data) => {
    const left = verifiedItems(data["verified"]).map(entryFields);
    return JSON.stringify(left) === JSON.stringify(kept);
  });
  return result;
}

/** Whether a frontmatter block parses apart from keys written more than once. */
export function hasOnlyRepeatedKeys(document: Document.Parsed): boolean {
  return document.errors.every((error) => error.code === "DUPLICATE_KEY");
}

const unreadable = Symbol("unreadable");

/** A pair's value as plain data, or `unreadable` when it can't be read (an alias gone wrong). */
function plainValue(document: Document.Parsed, value: unknown): unknown {
  try {
    return isNode(value) ? value.toJS(document) : value;
  } catch {
    return unreadable;
  }
}

/**
 * Frontmatter with a key written more than once: YAML readers disagree on which `verified` counts
 * (the first, the last, or none), so every `verified` pair is read, and when any of them holds a
 * picked entry (or can't be read) every one of them goes. Nothing else changes, and the other
 * repeated keys stay as they are.
 */
function removeEveryVerified(
  note: ParsedNote,
  document: Document.Parsed,
  drop: (entry: VerifiedEntryFields) => boolean,
): ParsedNote {
  const frontmatter = note.frontmatter;
  const map = document.contents;
  if (frontmatter === null || map === null) return note;
  const { source } = frontmatter;
  if (!isMap(map) || source[rangeOf(map)[0]] === "{") {
    throw new FrontmatterEditError("The frontmatter must be a block of `key: value` fields.");
  }
  const pairs = map.items.filter((pair) => isScalar(pair.key) && pair.key.value === "verified");
  const picked = pairs.some((pair) => {
    const value = plainValue(document, pair.value);
    return value === unreadable || verifiedItems(value).map(entryFields).some(drop);
  });
  if (!picked) return note;
  const yaml = applySplices(
    source,
    pairs.map((pair) => removePair(source, pair)),
  );
  const result = parseNote(
    note.text.slice(0, frontmatter.offset) +
      yaml +
      note.text.slice(frontmatter.offset + source.length),
  );
  const after = result.frontmatter;
  const parsed = after === null ? null : documentOf(after);
  if (
    after === null ||
    parsed === null ||
    !hasOnlyRepeatedKeys(parsed) ||
    // every problem left is a repeated key: the values still read (no alias left dangling)
    result.problems.length !== parsed.errors.length ||
    Object.hasOwn(after.data, "verified") ||
    !sameExcept(frontmatter.data, after.data, ["verified"])
  ) {
    throw new FrontmatterEditError(
      "`verified` can't be removed without changing other fields (a YAML anchor or alias); edit it by hand.",
    );
  }
  return result;
}

/**
 * Removes the `verified` entries `drop` picks, reading each one exactly like `readProvenance`
 * (a single `{ by, at }` map counts as one entry, aliases are resolved, `by` is trimmed). A plain
 * list loses just those items, every other line kept as it is (comments, order, flow or block
 * style); anything it can't edit that precisely (one map, aliases, a list left empty) loses the
 * whole `verified` field instead, so a picked entry never stays. Frontmatter with a key written
 * twice loses every `verified` pair when any of them holds a picked entry (readers disagree on
 * which one counts). Returns the note unchanged when nothing is picked. Throws a
 * `FrontmatterEditError` when even the field can't be removed (the frontmatter isn't valid YAML,
 * or another field shares its anchor).
 */
export function removeVerified(
  note: ParsedNote,
  drop: (entry: VerifiedEntryFields) => boolean,
): ParsedNote {
  if (note.frontmatter === null) return note;
  const document = documentOf(note.frontmatter);
  if (document.errors.length > 0) {
    if (!hasOnlyRepeatedKeys(document)) {
      throw new FrontmatterEditError(
        "The note's frontmatter is not valid YAML; fix it before editing.",
      );
    }
    return removeEveryVerified(note, document, drop);
  }
  const entries = verifiedItems(note.frontmatter.data["verified"]).map(entryFields);
  const dropped = entries.map((entry) => drop(entry));
  if (!dropped.includes(true)) return note;
  const kept = entries.filter((_, index) => dropped[index] !== true);
  if (kept.length > 0) {
    try {
      const precise = spliceOut(note, dropped, kept);
      if (precise !== null) return precise;
    } catch (error) {
      if (!(error instanceof FrontmatterEditError)) throw error;
    }
  }
  return removeField(note, "verified");
}
