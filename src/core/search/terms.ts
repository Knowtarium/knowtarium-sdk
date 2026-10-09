// How text becomes search terms. The index, the queries and the highlighter share these, so a
// highlighted word is exactly a word the index matched. Changing them changes the terms in a
// cached index: bump the index format version when you do.

/** Word separators: whitespace and punctuation (MiniSearch's default tokenizer splits on these). */
const WORD = /[^\n\r\p{Z}\p{P}]+/gu;

/** Scripts written without spaces between words: their runs are split into words separately. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** Without `Intl.Segmenter`: one term per character of those scripts, runs of the rest kept. */
const FALLBACK_PIECES =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;

/** A word with its position in the text (UTF-16 offsets, as `String.prototype.slice` uses). */
export interface Token {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

interface Piece {
  readonly start: number;
  readonly text: string;
}

let segmenter: Intl.Segmenter | null | undefined;

/** A word segmenter when the runtime has one (all current browsers, Node and Workers do). */
function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter =
        typeof Intl === "object" && typeof Intl.Segmenter === "function"
          ? new Intl.Segmenter(undefined, { granularity: "word" })
          : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** Splits a run with unspaced scripts into words (dictionary based where available). */
function splitUnspaced(piece: Piece, out: Piece[]): void {
  const words = wordSegmenter();
  if (words === null) {
    for (const match of piece.text.matchAll(FALLBACK_PIECES)) {
      out.push({ start: piece.start + match.index, text: match[0] });
    }
    return;
  }
  for (const segment of words.segment(piece.text)) {
    if (segment.isWordLike !== false && segment.segment.trim() !== "") {
      out.push({ start: piece.start + segment.index, text: segment.segment });
    }
  }
}

function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  const unspaced = UNSPACED.test(text);
  for (const match of text.matchAll(WORD)) {
    const piece = { start: match.index, text: match[0] };
    if (unspaced && UNSPACED.test(piece.text)) splitUnspaced(piece, out);
    else out.push(piece);
  }
  return out;
}

/** Lower case without accents, so `Résumé` finds `resume`. */
export function normalizeTerm(term: string): string {
  return term.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a text, as written. */
export function tokenize(text: string): string[] {
  return pieces(text).map((piece) => piece.text);
}

/** The words of a text with their positions, normalized. */
export function tokensWithPositions(text: string): Token[] {
  return pieces(text).map((piece) => ({
    start: piece.start,
    end: piece.start + piece.text.length,
    term: normalizeTerm(piece.text),
  }));
}

/** For tests: forget the segmenter, so the next call looks for one again. */
export function resetWordSegmenter(): void {
  segmenter = undefined;
}
