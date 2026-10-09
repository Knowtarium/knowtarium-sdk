// The values a change removed or replaced (numbers, dates, names), and finding them in other
// notes: a note that still says the old value may now contradict the change.

/** A value from a note's text. */
export interface ChangedValue {
  /** As written (`2.4%`, `$1,200`, `2026-09-26`, `Acme Cloud`). */
  readonly text: string;
  readonly kind: "number" | "date" | "name";
  /** What is searched for in other notes: the number without its unit, or the text. */
  readonly needle: string;
}

const DATE = /(?<![\p{L}\p{N}])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}])/gu;
const NUMBER = /(?<![\p{L}\p{N}_.,])[$€£]?\d+(?:[.,]\d+)*%?(?![\p{L}\p{N}_])/gu;
/** Capitalized words, possibly several in a row (`Acme Cloud`). */
const NAME = /\p{Lu}[\p{L}\p{N}'’-]*(?:[ \t]+\p{Lu}[\p{L}\p{N}'’-]*)*/gu;
/** A capitalized word right after these starts a sentence, a heading or an item: not a name. */
const SENTENCE_START = /(?:^|[.!?:#>*\-+|\n]|\d\.)\s*$/;

function numberNeedle(text: string): string {
  return text.replace(/^[$€£]/, "").replace(/%$/, "");
}

/** Whether a number is specific enough to search for (not a lone digit). */
function isSpecific(text: string): boolean {
  const digits = numberNeedle(text);
  return digits.length >= 2 || /[.,%$€£]/.test(text);
}

/** The values in a text, by their written form, in order of appearance. */
export function valuesIn(text: string): Map<string, ChangedValue> {
  const values = new Map<string, ChangedValue>();
  for (const match of text.matchAll(DATE)) {
    values.set(match[0], { text: match[0], kind: "date", needle: match[0] });
  }
  // blank out dates so their parts aren't read as numbers again
  const rest = text.replace(DATE, (date) => " ".repeat(date.length));
  for (const match of rest.matchAll(NUMBER)) {
    if (!isSpecific(match[0]) || values.has(match[0])) continue;
    values.set(match[0], { text: match[0], kind: "number", needle: numberNeedle(match[0]) });
  }
  for (const match of rest.matchAll(NAME)) {
    const before = rest.slice(Math.max(0, match.index - 12), match.index);
    if (match[0].length < 3 || SENTENCE_START.test(before) || values.has(match[0])) continue;
    values.set(match[0], { text: match[0], kind: "name", needle: match[0] });
  }
  return values;
}

/** The values in `before` that `after` no longer has, at most `limit` of them. */
export function changedValues(before: string, after: string, limit = 8): ChangedValue[] {
  const kept = valuesIn(after);
  return [...valuesIn(before).values()].filter((value) => !kept.has(value.text)).slice(0, limit);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A matcher for a value in other text: whole numbers and whole words only. */
export function valueMatcher(value: ChangedValue): RegExp {
  const needle = escape(value.needle);
  if (value.kind === "number") {
    // 2.4 matches "2.4%" and "2.4 percent", not "12.4" or "2.45"
    return new RegExp(`(?<![\\p{N}.,])${needle}(?![\\p{N}]|[.,]\\p{N})`, "u");
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, "u");
}
