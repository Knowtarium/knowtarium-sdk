/** The line ending a note uses; edits write new lines with the same one. */
export type LineEnding = "\n" | "\r\n";

/**
 * What can be wrong with a note. Reading never throws: every problem is reported on the note it
 * belongs to, and the rest of the workspace loads.
 *
 * - `frontmatter-unclosed`: the note starts with `---` but has no closing `---` line
 * - `frontmatter-yaml`: the frontmatter is not valid YAML
 * - `frontmatter-not-a-map`: the frontmatter is valid YAML but not a key-value mapping
 * - `field-invalid`: an OKF field has the wrong shape (see `schema`)
 */
export type NoteProblemCode =
  "frontmatter-unclosed" | "frontmatter-yaml" | "frontmatter-not-a-map" | "field-invalid";

export interface NoteProblem {
  readonly code: NoteProblemCode;
  readonly message: string;
  /** 1-based line in the note's full text, when known. */
  readonly line?: number;
  /** The frontmatter field, for `field-invalid` (a dotted path such as `verified.0.at`). */
  readonly field?: string;
}

/**
 * A note's YAML frontmatter. The parsed `yaml` Document behind it stays inside core (the edits use
 * it), so nothing outside can change a note without going through the `frontmatter` functions.
 */
export interface Frontmatter {
  /** The YAML text between the `---` fences, exactly as written. */
  readonly source: string;
  /** Where `source` starts in the note's full text. */
  readonly offset: number;
  /** The 1-based line of the note where `source` starts. */
  readonly line: number;
  /**
   * Plain values of the frontmatter, deeply frozen; `{}` when it is empty, not a mapping or has
   * YAML syntax errors. With duplicate keys the last value wins (and a problem is reported).
   */
  readonly data: Readonly<Record<string, unknown>>;
}

/** A note's text split into frontmatter and body. Frozen: edits return a new `ParsedNote`. */
export interface ParsedNote {
  /** The full text, byte for byte. Serializing a note returns exactly this. */
  readonly text: string;
  readonly eol: LineEnding;
  /** `null` when the note has no frontmatter, or when it is unclosed (see `problems`). */
  readonly frontmatter: Frontmatter | null;
  /** Everything after the closing fence (or the whole text, minus a byte order mark). */
  readonly body: string;
  /** Where `body` starts in `text`. */
  readonly bodyOffset: number;
  /** The 1-based line of `text` where `body` starts. */
  readonly bodyLine: number;
  /** Frontmatter problems found while parsing (field problems come from `schema`). */
  readonly problems: readonly NoteProblem[];
}
