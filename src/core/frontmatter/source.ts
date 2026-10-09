// Offsets and text helpers over the YAML source of a frontmatter block. Edits splice new text into
// the source at exact node ranges, so every byte outside the edited nodes stays as it was.
import { isCollection, isNode, isScalar, type Pair, type Scalar } from "yaml";

/** Replace `source.slice(start, end)` with `text`. */
export interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Applies non-overlapping splices to a source text. */
export function applySplices(source: string, splices: readonly Splice[]): string {
  let result = source;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

/** The offset where the line containing `offset` starts. */
export function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

/** The offset just past the line break ending the line that contains `offset - 1`. */
export function lineEndAfter(source: string, offset: number): number {
  if (offset > 0 && source[offset - 1] === "\n") return offset;
  const newline = source.indexOf("\n", offset);
  return newline === -1 ? source.length : newline + 1;
}

/** The 0-based column of an offset. */
export function columnOf(source: string, offset: number): number {
  return offset - lineStart(source, offset);
}

/** A node's `[start, valueEnd]` range, which the `yaml` parser sets on every parsed node. */
export function rangeOf(node: unknown): readonly [number, number] {
  const range = isNode(node) ? node.range : undefined;
  if (range === undefined || range === null) throw new Error("The YAML node has no source range");
  return [range[0], range[1]];
}

/** The offset just past the `:` that follows a pair's key. */
export function colonEnd(source: string, pair: Pair): number {
  const [, keyEnd] = rangeOf(pair.key);
  const colon = source.indexOf(":", keyEnd);
  if (colon === -1) throw new Error("The YAML pair has no `:` after its key");
  return colon + 1;
}

/** Whether a flow collection (`{ }` or `[ ]`) starts at the node. */
export function isFlowCollection(source: string, node: unknown): boolean {
  if (!isCollection(node)) return false;
  const char = source[rangeOf(node)[0]];
  return char === "{" || char === "[";
}

/** Whether the node is a scalar written on one line after its key (plain or quoted, not `|` or `>`). */
export function isInlineScalar(node: unknown): node is Scalar {
  if (!isScalar(node)) return false;
  const [start, end] = rangeOf(node);
  return start < end && node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED";
}

/**
 * The splice that replaces a pair's whole value. An inline scalar replaced by inline text is
 * swapped in place (keeping any comment after it); anything else (an empty value, a block scalar,
 * a collection, or block text) is replaced from the `:` on, keeping the line break that ends it. `text` is either inline (`value`) or a block that starts with a line
 * break (`\n  - item`).
 */
export function replaceValue(source: string, pair: Pair, text: string): Splice {
  const value = pair.value;
  const block = text.startsWith("\n") || text.startsWith("\r\n");
  if (!block && isInlineScalar(value)) {
    const [start, end] = rangeOf(value);
    return { start, end, text };
  }
  const start = colonEnd(source, pair);
  let end = isNode(value) ? Math.max(start, rangeOf(value)[1]) : start;
  while (end > start && (source[end - 1] === "\n" || source[end - 1] === "\r")) end--;
  return { start, end, text: block ? text : ` ${text}` };
}
