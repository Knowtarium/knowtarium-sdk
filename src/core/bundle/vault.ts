import { extensionOf, fileNameOf, folderOf, resolveRelative, stemOf } from "../path/index.js";
import type { AmbiguousLink } from "./types.js";

/** A file of the bundle: where it was and where it goes. */
export interface VaultEntry {
  /** The normalized path in the bundle as given. */
  readonly original: string;
  /** Its path in the workspace (a reserved name renamed). */
  readonly final: string;
  readonly kind: "note" | "attachment";
}

/** A link target found, with the files it could also have meant. */
export interface Resolution {
  readonly entry: VaultEntry;
  /** Every file the name matched, when more than one did. */
  readonly candidates: readonly string[];
}

const lower = (text: string) => text.toLowerCase();

/** The name a link uses for a file: a note without `.md`, anything else with its extension. */
function linkName(entry: VaultEntry): string {
  return entry.kind === "note" ? stemOf(entry.original) : fileNameOf(entry.original);
}

/** The path a link uses for a file (no `.md` for notes). */
function linkPath(entry: VaultEntry): string {
  const folder = folderOf(entry.original);
  const name = linkName(entry);
  return folder === "" ? name : `${folder}/${name}`;
}

/**
 * The files of a vault, looked up the way Obsidian resolves link text: an exact path (with or
 * without `.md`), a path relative to the linking note, then a path suffix or a bare name. When a
 * name matches several files, Obsidian's choice wins: the one in the linking note's folder, else
 * the shortest path, else the first alphabetically; the link is reported as ambiguous.
 * Letter case is ignored, as in Obsidian.
 */
export class Vault {
  private readonly byPath = new Map<string, VaultEntry>();
  private readonly byName = new Map<string, VaultEntry[]>();

  constructor(readonly entries: readonly VaultEntry[]) {
    for (const entry of entries) {
      this.byPath.set(lower(entry.original), entry);
      if (entry.kind === "note") this.byPath.set(lower(linkPath(entry)), entry);
      const name = lower(linkName(entry));
      this.byName.set(name, [...(this.byName.get(name) ?? []), entry]);
    }
  }

  /** The entry at an exact bundle path, if any. */
  at(path: string): VaultEntry | undefined {
    return this.byPath.get(lower(path));
  }

  /** Resolves a wikilink target (no fragment) from a note in `fromFolder`. */
  resolveName(target: string, fromFolder: string): Resolution | null {
    const cleaned = target.replace(/\\/g, "/").replace(/^\/+/, "");
    const exact = this.at(cleaned);
    if (exact !== undefined) return { entry: exact, candidates: [] };
    const relative = resolveRelative(fromFolder, cleaned);
    const near = relative === null ? undefined : this.at(relative);
    if (near !== undefined) return { entry: near, candidates: [] };
    const base = lower(cleaned.slice(cleaned.lastIndexOf("/") + 1).replace(/\.md$/i, ""));
    const withExtension = lower(cleaned.slice(cleaned.lastIndexOf("/") + 1));
    const pool = [...(this.byName.get(base) ?? []), ...(this.byName.get(withExtension) ?? [])];
    const suffix = cleaned.includes("/") ? `/${lower(cleaned).replace(/\.md$/, "")}` : null;
    const candidates = [...new Set(pool)].filter(
      (entry) =>
        suffix === null ||
        `/${lower(linkPath(entry))}`.endsWith(suffix) ||
        `/${lower(entry.original)}`.endsWith(suffix),
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) =>
        Number(folderOf(b.original) === fromFolder) - Number(folderOf(a.original) === fromFolder) ||
        a.original.length - b.original.length ||
        a.original.localeCompare(b.original),
    );
    const [entry] = candidates;
    if (entry === undefined) return null;
    return {
      entry,
      candidates: candidates.length > 1 ? candidates.map((candidate) => candidate.original) : [],
    };
  }

  /** Resolves a markdown link destination (URL-decoded, no fragment): relative first, then from the root. */
  resolvePath(target: string, fromFolder: string): VaultEntry | null {
    const relative = resolveRelative(fromFolder, target);
    return (relative === null ? undefined : this.at(relative)) ?? this.at(target) ?? null;
  }
}

/** How many of an ambiguous link's matches the report lists. */
const CANDIDATES_SHOWN = 10;

/** An ambiguity for the report (the first matches only, with the total). */
export function ambiguity(path: string, link: string, resolution: Resolution): AmbiguousLink {
  return {
    path,
    link,
    chosen: resolution.entry.final,
    candidates: resolution.candidates.slice(0, CANDIDATES_SHOWN),
    total: resolution.candidates.length,
  };
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".avif",
]);

/** Whether a path is an image a markdown image link can show. */
export function isImage(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}
