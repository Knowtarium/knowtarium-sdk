import {
  type Actor,
  setDescription,
  setGenerated,
  setTitle,
  setType,
} from "../frontmatter/index.js";
import type { ParsedNote } from "../note/index.js";

/** The type an imported note gets when it has none (OKF's only required field). */
export const DEFAULT_TYPE = "Note";

const DESCRIPTION_MAX = 200;
/** How much of a paragraph is read for a description: bounds the work on a huge one. */
const PARAGRAPH_SCAN = 2000;

/**
 * The text of the first level-1 heading (`# Title`, closing `#`s dropped), or null. Plain string
 * work, no backtracking regex, so a hostile line can't stall an import.
 */
export function firstHeading(body: string): string | null {
  for (const raw of body.split("\n")) {
    if (!/^#[ \t]/.test(raw)) continue;
    let text = raw.slice(1).trimEnd();
    // an optional closing sequence of `#`s, when a space or tab comes before it
    let end = text.length;
    while (end > 0 && text[end - 1] === "#") end--;
    if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) {
      text = text.slice(0, end);
    }
    const title = text.trim();
    if (title !== "") return title;
  }
  return null;
}

/** Markdown reduced to its words: links to their text, emphasis and code marks dropped. */
function plain(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first paragraph of prose, as a one-line description: headings, lists, quotes, tables,
 * code, callouts and embeds are skipped; cut at a word boundary to 200 characters. Null when the
 * note has no such paragraph.
 */
export function firstParagraph(body: string): string | null {
  let inFence = false;
  for (const block of body.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/)) {
    const trimmed = block.trim();
    const fences = trimmed.match(/^(```|~~~)/gm)?.length ?? 0;
    if (inFence || trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (fences % 2 === 1) inFence = !inFence;
      continue;
    }
    if (trimmed === "" || /^(#|>|\||[-*+] |\d+[.)] |!\[|<|---|\$\$|%%)/.test(trimmed)) continue;
    const text = plain(trimmed.slice(0, PARAGRAPH_SCAN));
    if (text === "") continue;
    if (text.length <= DESCRIPTION_MAX) return text;
    const cut = text.slice(0, DESCRIPTION_MAX);
    const space = cut.lastIndexOf(" ");
    return (space > DESCRIPTION_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
  }
  return null;
}

/**
 * Adds the OKF fields an imported Obsidian note lacks, keeping every existing key as written:
 * `type` (`Note`), `title` (the first heading, else the file name), `description` (the first
 * paragraph) and `generated` (the importing person, now). `stale_after` stays unset.
 */
export function addOkfFields(
  note: ParsedNote,
  details: { readonly stem: string; readonly person: Actor; readonly at: Date | string },
): ParsedNote {
  const data = note.frontmatter?.data ?? {};
  let result = note;
  if (!("type" in data)) result = setType(result, DEFAULT_TYPE);
  if (!("title" in data)) result = setTitle(result, firstHeading(note.body) ?? details.stem);
  if (!("description" in data)) {
    const description = firstParagraph(note.body);
    if (description !== null) result = setDescription(result, description);
  }
  if (!("generated" in data)) result = setGenerated(result, details.person, details.at);
  return result;
}
