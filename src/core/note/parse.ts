import { isMap, parseDocument } from "yaml";

import { attachDocument } from "./document.js";
import { deepFreeze } from "./freeze.js";
import { detectLineEnding, lineAt, splitNote } from "./split.js";
import type { Frontmatter, NoteProblem, ParsedNote } from "./types.js";

function readData(
  document: ReturnType<typeof parseDocument>,
  line: number,
  problems: NoteProblem[],
): Record<string, unknown> {
  if (document.contents === null) return {};
  if (!isMap(document.contents)) {
    problems.push({
      code: "frontmatter-not-a-map",
      message: "The frontmatter must be a list of `key: value` fields.",
      line,
    });
    return {};
  }
  try {
    return document.toJS() as Record<string, unknown>;
  } catch (error) {
    // alias expansion limits and the like: the note still loads, without frontmatter values
    problems.push({
      code: "frontmatter-yaml",
      message: `The frontmatter can't be read: ${error instanceof Error ? error.message : String(error)}`,
      line,
    });
    return {};
  }
}

function parseFrontmatter(
  text: string,
  source: string,
  offset: number,
  problems: NoteProblem[],
): Frontmatter {
  const line = lineAt(text, offset);
  // `silent`: core never writes to the console (yaml would warn, for one, about a key that is a
  // collection, like the `{{date}}` of a template; the key is read as text all the same)
  const document = parseDocument(source, { prettyErrors: false, logLevel: "silent" });
  for (const error of document.errors) {
    const duplicate = error.code === "DUPLICATE_KEY";
    problems.push({
      code: "frontmatter-yaml",
      message: duplicate
        ? `A frontmatter key appears twice; the last value is used: ${error.message}`
        : `Invalid YAML in the frontmatter: ${error.message}`,
      // an error found at the very end (an unclosed list) points at the last line, not the fence
      line: line + lineAt(source, Math.min(error.pos[0], Math.max(0, source.length - 1))) - 1,
    });
  }
  // duplicate keys still leave a readable mapping; any other error means the values can't be trusted
  const readable = document.errors.every((error) => error.code === "DUPLICATE_KEY");
  const data = readable ? readData(document, line, problems) : {};
  const frontmatter: Frontmatter = Object.freeze({
    source,
    offset,
    line,
    data: deepFreeze(data),
  });
  attachDocument(frontmatter, document);
  return frontmatter;
}

/**
 * Parses a note's text into frontmatter and body. Never throws: missing frontmatter is normal,
 * and unclosed or invalid frontmatter is reported in `problems` while the body stays readable.
 */
export function parseNote(text: string): ParsedNote {
  const sections = splitNote(text);
  const problems: NoteProblem[] = [];
  if (sections.unclosed) {
    problems.push({
      code: "frontmatter-unclosed",
      message: "The note starts a frontmatter block with `---` but never closes it.",
      line: 1,
    });
  }
  const frontmatter =
    sections.frontmatter === null
      ? null
      : parseFrontmatter(text, sections.frontmatter.source, sections.frontmatter.offset, problems);

  return Object.freeze({
    text,
    eol: detectLineEnding(text),
    frontmatter,
    body: text.slice(sections.bodyOffset),
    bodyOffset: sections.bodyOffset,
    bodyLine: lineAt(text, sections.bodyOffset),
    problems: deepFreeze(problems),
  });
}

/** A note's text, exactly as parsed or edited: edits keep every byte they don't change. */
export function serializeNote(note: ParsedNote): string {
  return note.text;
}
