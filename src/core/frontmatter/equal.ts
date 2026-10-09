/** Structural equality for plain frontmatter values (what `yaml`'s `toJS` produces). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.hasOwn(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Whether two frontmatter objects agree on every top-level key except the edited ones. */
export function sameExcept(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  edited: readonly string[],
): boolean {
  const others = (data: Readonly<Record<string, unknown>>) =>
    Object.keys(data).filter((key) => !edited.includes(key));
  const keys = others(before);
  return (
    keys.length === others(after).length &&
    keys.every((key) => Object.hasOwn(after, key) && deepEqual(before[key], after[key]))
  );
}
