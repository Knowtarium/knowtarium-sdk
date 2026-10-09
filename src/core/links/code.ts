// Blanks out the parts of a markdown body where links don't count: fenced and indented code
// blocks, inline code spans and HTML comments. Every line and column stays where it was.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const INDENTED = /^(?: {4}|\t)/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

const blank = (text: string): string => text.replace(/[^\r]/g, " ");

function maskInlineCode(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    const char = line.charAt(i);
    if (char !== "`") {
      result += char;
      i++;
      continue;
    }
    let run = 0;
    while (line[i + run] === "`") run++;
    const ticks = "`".repeat(run);
    let close = line.indexOf(ticks, i + run);
    while (close !== -1 && line[close + run] === "`") {
      let skip = close;
      while (line[skip] === "`") skip++;
      close = line.indexOf(ticks, skip);
    }
    if (close === -1) {
      result += ticks;
      i += run;
      continue;
    }
    result += " ".repeat(close + run - i);
    i = close + run;
  }
  return result;
}

/** Blanks HTML comments, which may span lines; `open` says whether one is still open. */
function maskComments(line: string, open: boolean): { text: string; open: boolean } {
  let text = "";
  let rest = line;
  let inside = open;
  while (rest !== "") {
    if (inside) {
      const end = rest.indexOf("-->");
      if (end === -1) return { text: text + blank(rest), open: true };
      text += blank(rest.slice(0, end + 3));
      rest = rest.slice(end + 3);
      inside = false;
    } else {
      const start = rest.indexOf("<!--");
      if (start === -1) return { text: text + rest, open: false };
      text += rest.slice(0, start);
      rest = rest.slice(start);
      inside = true;
    }
  }
  return { text, open: inside };
}

/**
 * Masks code and comments in a body's lines. Fences close only on a fence of the same character,
 * at least as long, with no info string. An indented line (four spaces or a tab) is code when it
 * follows a blank line or other code, and is not the continuation of a list item.
 */
export function maskCode(lines: readonly string[]): string[] {
  let fence: string | null = null;
  let comment = false;
  let indentedCode = false;
  let previousBlank = true;
  let inList = false;
  return lines.map((line) => {
    const isBlank = line.trim() === "";
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close?.startsWith(fence.charAt(0)) === true && close.length >= fence.length) fence = null;
      previousBlank = false;
      return blank(line);
    }
    if (!comment && !isBlank && INDENTED.test(line) && !inList && (previousBlank || indentedCode)) {
      indentedCode = true;
      return blank(line);
    }
    if (!isBlank) indentedCode = false;
    const marker = comment ? undefined : FENCE_OPEN.exec(line)?.[1];
    if (marker !== undefined) {
      fence = marker;
      previousBlank = false;
      return blank(line);
    }
    if (!isBlank) {
      if (LIST_ITEM.test(line)) inList = true;
      else if (!/^[ \t]/.test(line)) inList = false;
    }
    previousBlank = isBlank;
    const masked = maskComments(line, comment);
    comment = masked.open;
    return maskInlineCode(masked.text);
  });
}
