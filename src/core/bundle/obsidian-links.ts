import { maskCode } from "../links/code.js";
import { parseLinks } from "../links/index.js";
import type { LinkRef } from "../links/index.js";
import { fileNameOf, folderOf } from "../path/index.js";
import { linkDestination, relativePath } from "./files.js";
import type { AmbiguousLink, RewrittenLink } from "./types.js";
import { ambiguity, isImage, type Vault, type VaultEntry } from "./vault.js";

/** What rewriting a note's links found. */
export interface LinkRewrite {
  readonly body: string;
  readonly rewritten: RewrittenLink[];
  readonly ambiguous: AmbiguousLink[];
  readonly unresolved: { path: string; link: string }[];
  readonly lossy: { path: string; link: string; reason: string }[];
}

/**
 * A markdown link with a new destination, everything else as written: the text, an angle-bracket
 * destination's brackets, and a title (`[text](<new path> "title")`).
 */
function withDestination(link: LinkRef, destination: string): string {
  const open = (link.embed ? 1 : 0) + 1 + (link.label ?? "").length;
  if (link.raw.slice(open, open + 2) !== "](") {
    return `${link.embed ? "!" : ""}[${link.label ?? ""}](${destination})`;
  }
  let start = open + 2;
  while (start < link.raw.length && /\s/.test(link.raw.charAt(start))) start++;
  const inner = link.raw.slice(start, -1);
  if (inner.startsWith("<")) {
    const close = inner.indexOf(">");
    return `${link.raw.slice(0, start)}<${destination}>${inner.slice(close + 1)})`;
  }
  let end = 0;
  while (end < inner.length && !/\s/.test(inner.charAt(end))) end++;
  return `${link.raw.slice(0, start)}${destination}${inner.slice(end)})`;
}

/** Same-note heading links (`[[#Heading]]`), which the link parser leaves out; code excluded. */
function sameNoteHeadingLinks(body: string): string[] {
  const found: string[] = [];
  for (const line of maskCode(body.split("\n"))) {
    for (const match of line.matchAll(/\[\[#[^\]\n]*\]\]/g)) found.push(match[0]);
  }
  return found;
}

/** Escapes the characters that would end a markdown link text early. */
function linkText(text: string): string {
  return text.replace(/([[\]\\])/g, "\\$1");
}

function fragmentPart(fragment: string | null): string {
  if (fragment === null || fragment === "") return "";
  // a block reference keeps its caret (`#^id`), as Obsidian writes it
  return `#${encodeURI(fragment).replace(/#/g, "%23").replace(/%5E/gi, "^")}`;
}

/** A size given as an embed alias (`![[image.png|300]]`, `|300x200`), which markdown can't express. */
const SIZE = /^\d+(?:x\d+)?$/;

/** The markdown for a wikilink or embed that resolved to `entry`. */
function convertWikilink(link: LinkRef, entry: VaultEntry, fromFolder: string): string {
  const destination =
    linkDestination(relativePath(fromFolder, entry.final)) + fragmentPart(link.fragment);
  const label = link.label ?? null;
  if (link.embed && entry.kind === "attachment" && isImage(entry.final)) {
    const alt = label === null || SIZE.test(label) ? fileNameOf(entry.final) : label;
    return `![${linkText(alt)}](${destination})`;
  }
  // a note embed (transclusion) or a file embed becomes a plain link: markdown can't embed them
  const fallback = entry.kind === "note" ? link.target : fileNameOf(entry.final);
  return `[${linkText(label ?? fallback)}](${destination})`;
}

function applyReplacements(
  body: string,
  replacements: readonly { line: number; column: number; length: number; text: string }[],
): string {
  const starts = [0];
  for (let index = body.indexOf("\n"); index !== -1; index = body.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  let result = body;
  const ordered = [...replacements].sort((a, b) => b.line - a.line || b.column - a.column);
  for (const replacement of ordered) {
    const offset = (starts[replacement.line - 1] ?? 0) + replacement.column - 1;
    result = result.slice(0, offset) + replacement.text + result.slice(offset + replacement.length);
  }
  return result;
}

/**
 * Rewrites the links of an Obsidian note: wikilinks and embeds become relative markdown links
 * (images stay images), and markdown links to a renamed file get its new path. Links in code are
 * left alone, and links to nothing in the vault stay as they were and are reported.
 */
export function rewriteObsidianLinks(
  body: string,
  from: { readonly original: string; readonly final: string },
  vault: Vault,
): LinkRewrite {
  const originalFolder = folderOf(from.original);
  const finalFolder = folderOf(from.final);
  const rewrite: LinkRewrite = { body, rewritten: [], ambiguous: [], unresolved: [], lossy: [] };
  for (const link of sameNoteHeadingLinks(body)) {
    rewrite.lossy.push({
      path: from.final,
      link,
      reason: "A link to a heading in the same note, kept as a wikilink.",
    });
  }
  const replacements: { line: number; column: number; length: number; text: string }[] = [];
  for (const link of parseLinks(body, 1)) {
    let text: string;
    if (link.kind === "wikilink") {
      const resolution = vault.resolveName(link.target, originalFolder);
      if (resolution === null) {
        rewrite.unresolved.push({ path: from.final, link: link.raw });
        continue;
      }
      if (resolution.candidates.length > 0) {
        rewrite.ambiguous.push(ambiguity(from.final, link.raw, resolution));
      }
      text = convertWikilink(link, resolution.entry, finalFolder);
      if (link.embed && resolution.entry.kind === "note") {
        rewrite.lossy.push({
          path: from.final,
          link: link.raw,
          reason: "An embedded note became a link: plain markdown can't embed a note.",
        });
      }
    } else {
      const entry = vault.resolvePath(link.target, originalFolder);
      if (entry === null) {
        rewrite.unresolved.push({ path: from.final, link: link.raw });
        continue;
      }
      const moved = entry.final !== entry.original || finalFolder !== originalFolder;
      if (!moved) continue;
      const destination =
        linkDestination(relativePath(finalFolder, entry.final)) + fragmentPart(link.fragment);
      text = withDestination(link, destination);
    }
    if (text !== link.raw) {
      replacements.push({ line: link.line, column: link.column, length: link.raw.length, text });
      rewrite.rewritten.push({ path: from.final, from: link.raw, to: text });
    }
  }
  return { ...rewrite, body: applyReplacements(body, replacements) };
}
