import type { Actor } from "../frontmatter/index.js";
import type { NoteProblem } from "../note/index.js";

/** A file as the caller read it from a folder picker or a zip: its path in the bundle and its bytes. */
export interface BundleFile {
  /** The path inside the bundle, with `/` or `\` separators (`notes/pricing.md`). */
  readonly path: string;
  /** The file's bytes, or its text when the caller already decoded it. */
  readonly data: Uint8Array | string;
}

/** A note of the import, ready to encrypt and upload. */
export interface ImportedNote {
  /** Its normalized workspace path. */
  readonly path: string;
  readonly text: string;
  /** Where it was in the bundle. */
  readonly source: string;
}

/** A non-note file of the import (an image, a PDF, a canvas), kept byte for byte. */
export interface ImportedAttachment {
  readonly path: string;
  readonly data: Uint8Array | string;
  readonly source: string;
}

/** A link the import rewrote. */
export interface RewrittenLink {
  /** The note it is in (its new path). */
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

/** A link that matched several files, with the one chosen the way Obsidian chooses. */
export interface AmbiguousLink {
  readonly path: string;
  readonly link: string;
  readonly chosen: string;
  /** The first matches (at most 10), the chosen one first. */
  readonly candidates: readonly string[];
  /** How many files matched in all. */
  readonly total: number;
}

/** What the import did, for the person to read before and after. */
export interface ImportReport {
  readonly source: "okf" | "obsidian";
  /** Why the import took the bundle as OKF or as an Obsidian vault. */
  readonly sourceReason: string;
  /** The shared top folder taken as the bundle's own folder and left out of every path, if any. */
  readonly root: string | null;
  /** Notes and attachments imported. */
  readonly notes: number;
  readonly attachments: number;
  /** Files given a new name (reserved names, a leading `/` removed). */
  readonly renamed: readonly {
    readonly from: string;
    readonly to: string;
    readonly reason: string;
  }[];
  readonly rewrittenLinks: readonly RewrittenLink[];
  readonly ambiguousLinks: readonly AmbiguousLink[];
  /** Links to nothing in the bundle, left as they were (already broken before the import). */
  readonly unresolvedLinks: readonly { readonly path: string; readonly link: string }[];
  /**
   * Obsidian syntax plain markdown can't carry: a note embed that became a link, a same-note
   * heading link (`[[#Heading]]`) or a wikilink in the frontmatter, kept as written.
   */
  readonly lossy: readonly {
    readonly path: string;
    readonly link: string;
    readonly reason: string;
  }[];
  /** Imported as they are, on purpose: daily notes, templates, canvases. */
  readonly untouched: readonly { readonly path: string; readonly reason: string }[];
  /** Not imported: app settings, plugins, hidden files. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** Not imported because the import can't decide for the person: fix and import again. */
  readonly conflicts: readonly {
    readonly path: string;
    readonly reason: string;
    readonly paths?: readonly string[];
  }[];
  /** Notes imported with problems (unreadable frontmatter, invalid fields), kept as they are. */
  readonly problems: readonly {
    readonly path: string;
    readonly problems: readonly NoteProblem[];
  }[];
  /** Files the import wrote: `index.md` in each folder, the root `log.md`. */
  readonly generated: readonly string[];
}

/** The result of an import: what to upload, and the report. */
export interface ImportResult {
  readonly notes: readonly ImportedNote[];
  readonly attachments: readonly ImportedAttachment[];
  /** Every folder, empty ones included, parents before children. */
  readonly folders: readonly string[];
  readonly report: ImportReport;
}

export interface ImportOptions {
  /** `auto` (default) treats a bundle with a `.obsidian/` folder as an Obsidian vault. */
  readonly source?: "auto" | "okf" | "obsidian";
  /**
   * Whether the bundle's root has a `.obsidian/` folder even when no file in it was passed (an
   * empty settings folder, or settings the caller didn't read), for `auto`.
   */
  readonly obsidianFolder?: boolean;
  /** The person importing: `generated.by` of converted Obsidian notes (`human:<id>`). */
  readonly person: Actor;
  /** The time of the import, for `generated.at` and the log entry. */
  readonly at: Date | string;
  /** The heading of the root `index.md` an Obsidian import writes (default: the vault's folder name). */
  readonly name?: string;
  /**
   * Whether a folder every path starts with is the bundle itself (a folder picker's relative
   * paths, a zip of the folder) rather than a folder in it. Default true; it is stripped only
   * when that folder holds the bundle's markers (`index.md`, `log.md` or `.obsidian/`).
   */
  readonly stripRoot?: boolean;
  /**
   * Refuse bundles with more files than this (default 50,000) or more bytes (default 1 GiB),
   * with an `ImportLimitError`, before any work. The caller still guards its own reading: check a
   * zip's entry sizes before inflating them (zip bombs), check the storage quota before
   * uploading, and run the import in a Web Worker.
   */
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}
