// Provenance entries (`{ by, at }`) as written in `generated` and in each `verified` item.
import { isMap, type Node } from "yaml";

import type { LineEnding } from "../note/types.js";
import { findPair } from "./edit.js";
import { renderScalar } from "./scalar.js";
import {
  columnOf,
  isFlowCollection,
  isInlineScalar,
  lineEndAfter,
  rangeOf,
  type Splice,
} from "./source.js";

/** Ordered `[key, value]` pairs of an entry, e.g. `[["by", actor], ["at", time]]`. */
export type EntryFields = readonly (readonly [string, string])[];

/** An entry as a flow mapping: `{ by: human:sara, at: 2026-09-30T12:00:00Z }`. */
export function flowEntry(fields: EntryFields, spaced = true): string {
  const inner = fields.map(([key, value]) => `${key}: ${renderScalar(value, { flow: true })}`);
  return spaced ? `{ ${inner.join(", ")} }` : `{${inner.join(", ")}}`;
}

/** An entry as block mapping lines, the first after `firstPrefix` and the rest at `keyIndent`. */
export function blockEntry(
  fields: EntryFields,
  firstPrefix: string,
  keyIndent: string,
  eol: LineEnding,
): string {
  return fields
    .map(([key, value], i) => `${i === 0 ? firstPrefix : keyIndent}${key}: ${renderScalar(value)}`)
    .join(eol);
}

/** Whether a flow mapping is written with inner spaces (`{ a: 1 }` rather than `{a: 1}`). */
export function isSpacedFlow(source: string, node: Node): boolean {
  return source[rangeOf(node)[0] + 1] === " ";
}

/**
 * Splices that set fields inside an existing mapping, keeping its style: existing inline scalars
 * are replaced in place (keeping their quoting), missing keys are added after the last entry.
 * Returns `null` when the node is not a non-empty mapping of inline scalars, so the caller
 * replaces the whole value instead.
 */
export function updateEntry(
  source: string,
  node: unknown,
  fields: EntryFields,
  eol: LineEnding,
): Splice[] | null {
  if (!isMap(node) || node.items.length === 0) return null;
  const map = node;
  const flow = isFlowCollection(source, map);
  const splices: Splice[] = [];
  const missing: [string, string][] = [];
  for (const [key, value] of fields) {
    const pair = findPair(map, key);
    if (pair === undefined) {
      missing.push([key, value]);
      continue;
    }
    if (!isInlineScalar(pair.value)) return null;
    const [start, end] = rangeOf(pair.value);
    splices.push({ start, end, text: renderScalar(value, { style: pair.value.type, flow }) });
  }
  if (missing.length > 0) {
    const last = map.items[map.items.length - 1];
    if (last === undefined) return null;
    const lastEnd = rangeOf(last.value ?? last.key)[1];
    if (flow) {
      const text = missing.map(
        ([key, value]) => `, ${key}: ${renderScalar(value, { flow: true })}`,
      );
      splices.push({ start: lastEnd, end: lastEnd, text: text.join("") });
    } else {
      const first = map.items[0];
      if (first === undefined) return null;
      const indent = " ".repeat(columnOf(source, rangeOf(first.key)[0]));
      const at = lineEndAfter(source, lastEnd);
      splices.push({ start: at, end: at, text: blockEntry(missing, indent, indent, eol) + eol });
    }
  }
  return splices;
}
