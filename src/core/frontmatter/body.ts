import { parseNote } from "../note/parse.js";
import type { ParsedNote } from "../note/types.js";

/**
 * Replaces the note's body. The frontmatter block, fences included, stays byte for byte; a closing
 * fence at the very end of the text gets a line break so the body starts on its own line. On a
 * note without frontmatter, a body that would itself read as frontmatter (it starts with a `---`
 * block) is kept as body by putting an empty frontmatter block in front of it.
 */
export function setBody(note: ParsedNote, body: string): ParsedNote {
  const head = note.text.slice(0, note.bodyOffset);
  const separator =
    note.frontmatter !== null && !head.endsWith("\n") && body !== "" ? note.eol : "";
  const result = parseNote(head + separator + body);
  if (result.body === body) return result;
  return parseNote(`${head}---${note.eol}---${note.eol}${body}`);
}
