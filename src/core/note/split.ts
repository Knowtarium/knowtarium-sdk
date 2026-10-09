import type { LineEnding } from "./types.js";

const BOM = "﻿";
const OPENING_FENCE = /^---[ \t]*\r?\n/;
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*\r?$/;

/** Where the parts of a note's text are. Offsets index into the full text. */
export interface NoteSections {
  /** The YAML between the fences, or `null` when there is no (closed) frontmatter. */
  readonly frontmatter: { readonly source: string; readonly offset: number } | null;
  /** The note opens a frontmatter block that never closes. */
  readonly unclosed: boolean;
  readonly bodyOffset: number;
}

/**
 * Splits a note into frontmatter and body. The frontmatter is the block between a first line of
 * `---` and the next line of `---` (or `...`), after an optional byte order mark.
 */
export function splitNote(text: string): NoteSections {
  const start = text.startsWith(BOM) ? BOM.length : 0;
  const opening = OPENING_FENCE.exec(text.slice(start));
  if (opening === null) return { frontmatter: null, unclosed: false, bodyOffset: start };

  const sourceOffset = start + opening[0].length;
  for (let lineStart = sourceOffset; lineStart <= text.length;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (CLOSING_FENCE.test(text.slice(lineStart, lineEnd))) {
      return {
        frontmatter: { source: text.slice(sourceOffset, lineStart), offset: sourceOffset },
        unclosed: false,
        bodyOffset: newline === -1 ? text.length : newline + 1,
      };
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return { frontmatter: null, unclosed: true, bodyOffset: start };
}

/** The note's line ending, taken from its first line break (`\n` when it has none). */
export function detectLineEnding(text: string): LineEnding {
  const newline = text.indexOf("\n");
  return newline > 0 && text[newline - 1] === "\r" ? "\r\n" : "\n";
}

/** The 1-based line number of an offset in a text. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}
