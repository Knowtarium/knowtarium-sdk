import { isMap, isScalar, parseDocument } from "yaml";

import { addVerified, isActor } from "../frontmatter/index.js";
import { parseNote } from "../note/index.js";
import { readProvenance } from "../trust/index.js";

/** One top-level frontmatter field as written: its key and its text, comments above it included. */
interface FieldBlock {
  readonly key: string;
  readonly text: string;
}

/** A frontmatter field that both sides changed differently. */
export interface FieldConflict {
  readonly field: string;
  /** The field's text on each side; `null` where the field is absent. */
  readonly base: string | null;
  readonly mine: string | null;
  readonly theirs: string | null;
}

/** A field of the merged frontmatter: agreed text, or a conflict to resolve. */
export type FieldHunk =
  | { readonly kind: "resolved"; readonly text: string }
  | ({ readonly kind: "conflict" } & FieldConflict);

/**
 * Splits frontmatter YAML into top-level fields, each from the line after the previous field
 * ends up to the end of its own value, so comments above a field travel with it. Null when the
 * YAML has errors (duplicate keys included) or isn't a mapping of plain keys: then the caller
 * merges lines instead.
 */
function fieldBlocks(source: string): FieldBlock[] | null {
  if (source === "") return [];
  const document = parseDocument(source, { logLevel: "silent" });
  const map = document.contents;
  if (document.errors.length > 0 || !isMap(map) || map.flow === true) return null;
  const blocks: FieldBlock[] = [];
  let start = 0;
  const pairs = map.items;
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (pair === undefined || !isScalar(pair.key) || typeof pair.key.value !== "string")
      return null;
    const next = pairs[index + 1];
    let end = source.length;
    if (next !== undefined) {
      const nextStart = rangeOf(next.key)?.[0];
      const valueEnd = (rangeOf(pair.value) ?? rangeOf(pair.key))?.[1];
      if (nextStart === undefined || valueEnd === undefined) return null;
      // the field ends with the line its value ends on; comments after that belong to the next
      const newline = source[valueEnd - 1] === "\n" ? valueEnd - 1 : source.indexOf("\n", valueEnd);
      end = newline === -1 ? source.length : newline + 1;
      if (end > lineStart(source, nextStart)) return null; // two fields on one line
    }
    blocks.push({ key: pair.key.value, text: source.slice(start, end) });
    start = end;
  }
  return blocks;
}

function rangeOf(node: unknown): readonly [number, number, number] | undefined {
  return (node as { range?: [number, number, number] } | null)?.range ?? undefined;
}

function lineStart(source: string, index: number): number {
  return source.lastIndexOf("\n", index - 1) + 1;
}

function byKey(blocks: readonly FieldBlock[]): Map<string, string> {
  return new Map(blocks.map((block) => [block.key, block.text]));
}

/** The `verified` entries a frontmatter text has, as `by at` keys. */
function verifiedEntries(source: string): { by: string; at: string }[] {
  const note = parseNote(`---\n${source}---\n`);
  return readProvenance(note.frontmatter?.data ?? {}).verified.flatMap((entry) =>
    entry.at === null ? [] : [{ by: entry.by, at: entry.at }],
  );
}

/**
 * `verified` changed on both sides: keeps theirs and adds the entries only mine added (checks are
 * append-only history, so both sides' new checks belong). Null when an entry can't be added as
 * written (then the field is a conflict).
 */
function unionVerified(
  base: string | undefined,
  mine: string,
  theirs: string,
  eol: string,
): string | null {
  const key = (entry: { by: string; at: string }) => `${entry.by} ${entry.at}`;
  const known = new Set([
    ...verifiedEntries(base ?? "").map(key),
    ...verifiedEntries(theirs).map(key),
  ]);
  let note = parseNote(`---${eol}${theirs}---${eol}`);
  for (const entry of verifiedEntries(mine)) {
    if (known.has(key(entry))) continue;
    if (!isActor(entry.by)) return null;
    try {
      note = addVerified(note, entry.by, entry.at);
    } catch {
      return null;
    }
  }
  return note.frontmatter?.source ?? null;
}

/**
 * Merges three frontmatter texts field by field: a field only one side changed takes that side's
 * text byte for byte, the same change on both sides is taken once, `verified` changed on both
 * sides keeps every check, and any other field both sides changed differently is a conflict.
 * A field one side removed and the other changed is a conflict too. Fields keep theirs' order,
 * with the fields theirs lacks after them. Null when any side can't be split into fields.
 *
 * A null `base` means the base is unknown (its content was removed after the history period):
 * then no side's change can be told from the other's, so every field that differs, or that only
 * one side has, is a conflict (`verified` too: an entry only one side has may be one the other
 * removed).
 */
export function mergeFrontmatter(
  base: string | null,
  mine: string,
  theirs: string,
  eol: string,
): FieldHunk[] | null {
  const known = base !== null;
  const blocks = [fieldBlocks(base ?? ""), fieldBlocks(mine), fieldBlocks(theirs)];
  const [baseBlocks, mineBlocks, theirsBlocks] = blocks;
  if (baseBlocks == null || mineBlocks == null || theirsBlocks == null) return null;
  const withEol = (text: string) => (text.endsWith("\n") ? text : text + eol);
  const [b, m, t] = [byKey(baseBlocks), byKey(mineBlocks), byKey(theirsBlocks)];
  // theirs' fields in their order, then fields theirs lacks that mine added or changed (a field
  // mine changed and theirs removed is a conflict, never silently dropped)
  const order = [
    ...theirsBlocks.map((block) => block.key),
    ...mineBlocks
      .map((block) => block.key)
      .filter((key) => !t.has(key) && (!known || m.get(key) !== b.get(key))),
  ];
  const hunks: FieldHunk[] = [];
  for (const field of order) {
    const [inBase, inMine, inTheirs] = [b.get(field), m.get(field), t.get(field)];
    let text: string | null | undefined;
    if (inMine === inTheirs) text = inTheirs;
    else if (!known) text = null;
    else if (inMine === inBase) text = inTheirs;
    else if (inTheirs === inBase) text = inMine;
    else if (field === "verified" && inMine !== undefined && inTheirs !== undefined) {
      text = unionVerified(inBase, withEol(inMine), withEol(inTheirs), eol);
    } else text = null;
    if (text === null) {
      hunks.push({
        kind: "conflict",
        field,
        base: inBase ?? null,
        mine: inMine ?? null,
        theirs: inTheirs ?? null,
      });
    } else if (text !== undefined) {
      hunks.push({ kind: "resolved", text: withEol(text) });
    }
  }
  return hunks;
}
