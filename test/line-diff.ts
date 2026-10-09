/** The lines two texts differ in: what is left after trimming their common first and last lines. */
export interface LineChange {
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

/** A single-hunk line diff, enough to assert that an edit touched only the lines it should. */
export function lineChange(before: string, after: string): LineChange {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}
