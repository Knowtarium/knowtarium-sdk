import { maskCode } from "./code.js";
import type { LinkRef } from "./types.js";

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MARKDOWN_LINK =
  /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//;

function splitFragment(target: string): [string, string | null] {
  const hash = target.indexOf("#");
  return hash === -1 ? [target, null] : [target.slice(0, hash), target.slice(hash + 1)];
}

function wikilink(embed: boolean, inner: string): Omit<LinkRef, "raw" | "line" | "column"> | null {
  // a pipe escaped for a markdown table (`[[a\|b]]`) still separates the alias
  const pipe = inner.search(/\\?\|/);
  const destination = pipe === -1 ? inner : inner.slice(0, pipe);
  const label = pipe === -1 ? null : inner.slice(inner.indexOf("|", pipe) + 1).trim();
  const [target, fragment] = splitFragment(destination.trim());
  if (target.trim() === "") return null; // a link within the same note
  return {
    kind: "wikilink",
    embed,
    target: target.trim(),
    fragment,
    label: label === null || label === "" ? null : label,
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function markdownLink(
  embed: boolean,
  text: string,
  destination: string,
): Omit<LinkRef, "raw" | "line" | "column"> | null {
  const unwrapped = destination.startsWith("<") ? destination.slice(1, -1) : destination;
  if (unwrapped === "" || URL_SCHEME.test(unwrapped)) return null; // external or empty
  const [target, fragment] = splitFragment(unwrapped);
  if (target === "") return null; // `#heading` within the same note
  return {
    kind: "markdown",
    embed,
    target: decode(target),
    fragment: fragment === null ? null : decode(fragment),
    label: text === "" ? null : text,
  };
}

/** Whether the character before `index` escapes it with a backslash (an odd run of backslashes). */
function isEscaped(line: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/**
 * Finds the wikilinks and internal markdown links in a note's body, skipping code (fenced,
 * indented and inline), HTML comments, escaped brackets (`\[[x]]`), external URLs and links within
 * the same note. `firstLine` is the line of the note where the body starts, so line numbers point
 * into the full note. Where the two syntaxes overlap, the wikilink wins: `[[a]](b.md)` is a link
 * to `a` followed by the text `(b.md)`, as Obsidian renders it.
 */
export function parseLinks(body: string, firstLine = 1): LinkRef[] {
  const lines = body.split("\n");
  const masked = maskCode(lines);
  const links: LinkRef[] = [];
  masked.forEach((maskedLine, index) => {
    const original = lines[index] ?? "";
    let line = maskedLine;
    const found: LinkRef[] = [];
    const at = (start: number, length: number) => ({
      raw: original.slice(start, start + length),
      line: firstLine + index,
      column: start + 1,
    });
    for (const match of maskedLine.matchAll(WIKILINK)) {
      if (isEscaped(maskedLine, match.index)) continue;
      const link = wikilink(match[1] === "!", match[2] ?? "");
      if (link !== null) found.push({ ...link, ...at(match.index, match[0].length) });
      // a wikilink's text can't also be part of a markdown link
      line =
        line.slice(0, match.index) +
        " ".repeat(match[0].length) +
        line.slice(match.index + match[0].length);
    }
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      if (isEscaped(line, match.index)) continue;
      const link = markdownLink(match[1] === "!", match[2] ?? "", match[3] ?? "");
      if (link !== null) found.push({ ...link, ...at(match.index, match[0].length) });
    }
    links.push(...found.sort((a, b) => a.column - b.column));
  });
  return links;
}
