import { diffLines, diffWordsWithSpace } from "diff";

import { DEFAULT_DIFF_LIMITS, type DiffLimits } from "./diff3.js";
import { splitLines } from "./lines.js";

/** One run of a diff: text both sides share, or text only the old or the new side has. */
export interface DiffPart {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

/** A diff with its totals, counted in the diff's units (lines or words). */
export interface TextDiff {
  readonly parts: readonly DiffPart[];
  readonly added: number;
  readonly removed: number;
  /** Whether the two texts are identical. */
  readonly unchanged: boolean;
  /** True when the diff gave up (see `DiffLimits`) and shows the whole text as replaced. */
  readonly coarse: boolean;
}

interface Change {
  value: string;
  added: boolean;
  removed: boolean;
  count: number;
}

function toDiff(changes: readonly Change[], countOf: (text: string, count: number) => number) {
  let added = 0;
  let removed = 0;
  const parts = changes.map((change): DiffPart => {
    if (change.added) {
      added += countOf(change.value, change.count);
      return { kind: "added", text: change.value };
    }
    if (change.removed) {
      removed += countOf(change.value, change.count);
      return { kind: "removed", text: change.value };
    }
    return { kind: "same", text: change.value };
  });
  return { parts, added, removed, unchanged: added === 0 && removed === 0, coarse: false };
}

/** The whole of `before` removed and the whole of `after` added, for a diff that gave up. */
function coarse(before: string, after: string, countOf: (text: string) => number): TextDiff {
  if (before === after) {
    return {
      parts: [{ kind: "same", text: before }],
      added: 0,
      removed: 0,
      unchanged: true,
      coarse: true,
    };
  }
  const parts: DiffPart[] = [
    ...(before === "" ? [] : [{ kind: "removed" as const, text: before }]),
    ...(after === "" ? [] : [{ kind: "added" as const, text: after }]),
  ];
  return { parts, added: countOf(after), removed: countOf(before), unchanged: false, coarse: true };
}

const words = (text: string) => text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;

function options(limits: DiffLimits) {
  return {
    timeout: limits.timeoutMs ?? DEFAULT_DIFF_LIMITS.timeoutMs,
    maxEditLength: limits.maxEditLength ?? DEFAULT_DIFF_LIMITS.maxEditLength,
  };
}

/**
 * A line diff between two versions of a note (jsdiff `diffLines`). Joining the `same` and
 * `removed` parts gives `before`, the `same` and `added` parts give `after`, byte for byte. A diff
 * too large for `limits` comes back coarse. Diffs of long notes belong in a Web Worker.
 */
export function lineDiff(before: string, after: string, limits: DiffLimits = {}): TextDiff {
  const changes = diffLines(before, after, options(limits));
  return changes === undefined
    ? coarse(before, after, (text) => splitLines(text).length)
    : toDiff(changes, (_text, count) => count);
}

/**
 * A word diff (jsdiff `diffWordsWithSpace`: words, punctuation, newlines and runs of spaces are
 * tokens), for showing what changed inside a line. `added` and `removed` count words only.
 */
export function wordDiff(before: string, after: string, limits: DiffLimits = {}): TextDiff {
  const changes = diffWordsWithSpace(before, after, options(limits));
  return changes === undefined ? coarse(before, after, words) : toDiff(changes, words);
}
