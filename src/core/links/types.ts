/** A link as written in a note's body, before it is resolved against the workspace. */
export interface LinkRef {
  /** `[[target]]` or `[text](target)`. */
  readonly kind: "wikilink" | "markdown";
  /** Written with a leading `!` (`![[image.png]]`, `![alt](image.png)`). */
  readonly embed: boolean;
  /** The link exactly as written. */
  readonly raw: string;
  /** The note name or path, without the fragment (markdown targets are URL-decoded). */
  readonly target: string;
  /** The heading or block after `#`, without the `#`. */
  readonly fragment: string | null;
  /** The wikilink alias (`[[target|alias]]`) or the markdown link text. */
  readonly label: string | null;
  /** 1-based line in the note's full text. */
  readonly line: number;
  /** 1-based column of the link's first character. */
  readonly column: number;
}

/** Where a link points. `asset` is a link to a non-note file (an image, a CSV). */
export type LinkResolution =
  | { readonly status: "note"; readonly noteId: string }
  | { readonly status: "ghost" }
  | { readonly status: "asset"; readonly path: string };

/** A link from one note, with where it resolved to. */
export interface ResolvedLink extends LinkRef {
  /** The id of the note the link is in. */
  readonly from: string;
  readonly resolution: LinkResolution;
}
