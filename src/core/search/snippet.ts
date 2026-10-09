// Snippets: a short window of a matched field, with the positions of the matched words, so the web
// app can render highlights without parsing anything (and without HTML in the index).
import { tokensWithPositions } from "./terms.js";

/** A highlighted range, as UTF-16 offsets into the text it belongs to (`[start, end)`). */
export interface Highlight {
  readonly start: number;
  readonly end: number;
}

export interface Snippet {
  /** The field the text comes from. */
  readonly field: string;
  /** The window, with line breaks and tabs turned into spaces. */
  readonly text: string;
  readonly highlights: readonly Highlight[];
  /** Whether text was cut before or after the window (show an ellipsis). */
  readonly truncatedStart: boolean;
  readonly truncatedEnd: boolean;
}

/** Where the matched words of a text are. */
export function highlightsIn(text: string, terms: ReadonlySet<string>): Highlight[] {
  return tokensWithPositions(text)
    .filter((token) => terms.has(token.term))
    .map(({ start, end }) => ({ start, end }));
}

/** Moves a cut position to the nearest space before it (within a short distance). */
function snapBack(text: string, at: number): number {
  if (at <= 0) return 0;
  const space = text.lastIndexOf(" ", at);
  return space > 0 && at - space < 20 ? space + 1 : at;
}

function snapForward(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const space = text.indexOf(" ", at);
  return space !== -1 && space - at < 20 ? space : at;
}

/**
 * A window of about `length` characters around the first matched word, or `null` when the text
 * has none. The window starts a little before the match so the reader sees its context.
 */
export function snippetOf(
  field: string,
  source: string,
  terms: ReadonlySet<string>,
  length = 160,
): Snippet | null {
  const text = source.replace(/\s/g, " ");
  const all = highlightsIn(text, terms);
  const first = all[0];
  if (first === undefined) return null;
  const lead = Math.min(Math.floor(length / 3), first.start);
  let start = snapBack(text, first.start - lead);
  // never cut into a surrogate pair
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start--;
  let end = snapForward(text, Math.max(start + length, first.end));
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end++;
  let window = text.slice(start, end);
  // leading spaces are trimmed; highlights shift with them
  const trimmed = window.length - window.trimStart().length;
  start += trimmed;
  window = window.trim();
  const highlights = all
    .filter((range) => range.start >= start && range.end <= start + window.length)
    .map((range) => ({ start: range.start - start, end: range.end - start }));
  return {
    field,
    text: window,
    highlights,
    truncatedStart: text.slice(0, start).trim() !== "",
    truncatedEnd: start + window.length < text.trimEnd().length,
  };
}
