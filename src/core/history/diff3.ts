import { diffArrays } from "diff";

/** A stretch of a three-way merge: agreed text, or a conflict with all three sides. */
export type MergeHunk =
  | { readonly kind: "resolved"; readonly text: string }
  | {
      readonly kind: "conflict";
      readonly base: string;
      readonly mine: string;
      readonly theirs: string;
    };

/**
 * How much work a diff may do before it gives up: jsdiff's `timeout` (milliseconds) and
 * `maxEditLength` (edits). A diff that gives up is replaced by a coarse one (the whole region as
 * changed), so a huge or wholly rewritten note answers quickly instead of freezing the page.
 */
export interface DiffLimits {
  readonly timeoutMs?: number;
  readonly maxEditLength?: number;
}

/** The limits a merge or diff uses unless told otherwise. */
export const DEFAULT_DIFF_LIMITS: Required<DiffLimits> = { timeoutMs: 250, maxEditLength: 5000 };

/** A line without its ending, so `\r\n`, `\n` and a missing final newline compare equal. */
export function lineKey(line: string): string {
  return line.replace(/\r?\n$/, "");
}

const sameLine = (a: string, b: string) => lineKey(a) === lineKey(b);

/**
 * For each index of `from`, the index of the same line in `to` along the longest common
 * subsequence; null when the diff gave up.
 */
function matchIndex(
  from: readonly string[],
  to: readonly string[],
  limits: DiffLimits,
): (number | undefined)[] | null {
  const changes = diffArrays([...from], [...to], {
    comparator: sameLine,
    timeout: limits.timeoutMs ?? DEFAULT_DIFF_LIMITS.timeoutMs,
    maxEditLength: limits.maxEditLength ?? DEFAULT_DIFF_LIMITS.maxEditLength,
  });
  if (changes === undefined) return null;
  const matched: (number | undefined)[] = new Array<number | undefined>(from.length);
  let i = 0;
  let j = 0;
  for (const change of changes) {
    if (change.added) j += change.count;
    else if (change.removed) i += change.count;
    else {
      for (let n = 0; n < change.count; n++) matched[i + n] = j + n;
      i += change.count;
      j += change.count;
    }
  }
  return matched;
}

const join = (lines: readonly string[]) => lines.join("");

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => sameLine(line, b[index] ?? ""));
}

/** Settles one stretch: a one-sided change wins, the same change counts once, else a conflict. */
function settle(
  base: readonly string[],
  mine: readonly string[],
  theirs: readonly string[],
): MergeHunk {
  if (sameLines(mine, base) || sameLines(mine, theirs)) {
    return { kind: "resolved", text: join(theirs) };
  }
  if (sameLines(theirs, base)) return { kind: "resolved", text: join(mine) };
  return { kind: "conflict", base: join(base), mine: join(mine), theirs: join(theirs) };
}

/**
 * A classic diff3 merge of line arrays: stretches where both sides kept the base agree (written
 * as theirs has them); in the stretches between, a change on one side only is taken, the same
 * change on both sides is taken once, and different changes on both sides are a conflict. Lines
 * that differ only in their ending (`\r\n` or `\n`, or a missing final newline) count as the same.
 * When a diff gives up (see `DiffLimits`), the whole text is one stretch.
 */
export function mergeLines(
  base: readonly string[],
  mine: readonly string[],
  theirs: readonly string[],
  limits: DiffLimits = {},
): MergeHunk[] {
  const toMine = matchIndex(base, mine, limits);
  const toTheirs = toMine === null ? null : matchIndex(base, theirs, limits);
  if (toMine === null || toTheirs === null) return [settle(base, mine, theirs)];
  const hunks: MergeHunk[] = [];
  const push = (hunk: MergeHunk) => {
    const last = hunks.at(-1);
    if (hunk.kind === "resolved" && last?.kind === "resolved") {
      hunks[hunks.length - 1] = { kind: "resolved", text: last.text + hunk.text };
    } else if (hunk.kind === "conflict" || hunk.text !== "") {
      hunks.push(hunk);
    }
  };
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < base.length || j < mine.length || k < theirs.length) {
    if (i < base.length && toMine[i] === j && toTheirs[i] === k) {
      push({ kind: "resolved", text: theirs[k] ?? "" });
      i++;
      j++;
      k++;
      continue;
    }
    // the next base line both sides still have, in order: the end of this unstable stretch
    let next = i;
    while (next < base.length && !((toMine[next] ?? -1) >= j && (toTheirs[next] ?? -1) >= k)) {
      next++;
    }
    const endMine = next < base.length ? (toMine[next] ?? mine.length) : mine.length;
    const endTheirs = next < base.length ? (toTheirs[next] ?? theirs.length) : theirs.length;
    push(settle(base.slice(i, next), mine.slice(j, endMine), theirs.slice(k, endTheirs)));
    i = next;
    j = endMine;
    k = endTheirs;
  }
  return hunks;
}
