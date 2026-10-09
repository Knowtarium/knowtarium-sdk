import type { LinkRef, ResolvedLink } from "../links/types.js";
import type { NoteProblem, ParsedNote } from "../note/types.js";
import type { OkfFields } from "../schema/fields.js";

/** A note as a caller hands it to core: already decrypted, with its workspace path. */
export interface NoteInput {
  /** Stable id (the sync API's note id). */
  readonly id: string;
  /** Workspace-relative path with its folders, ending in `.md` (`research/pricing.md`). */
  readonly path: string;
  /** The note's full text: frontmatter and body. */
  readonly text: string;
}

/** `index` and `log` are OKF's reserved files, one of each per folder. */
export type NoteRole = "note" | "index" | "log";

/** One note, parsed and validated. Links are resolved at the workspace level. */
export interface Note {
  readonly id: string;
  /** Normalized path. */
  readonly path: string;
  /** The folder the note is in (`""` for the root). */
  readonly folder: string;
  readonly fileName: string;
  readonly role: NoteRole;
  /** The frontmatter `title`, or the file name without `.md`. */
  readonly title: string;
  readonly parsed: ParsedNote;
  /** Every frontmatter value, known and unknown keys alike. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** The valid OKF fields, typed. */
  readonly fields: OkfFields;
  readonly body: string;
  /** Frontmatter problems plus field problems. */
  readonly problems: readonly NoteProblem[];
  /** Links in the body, unresolved. */
  readonly linkRefs: readonly LinkRef[];
}

/** A folder, derived from note paths (plus any empty folders the caller lists). */
export interface Folder {
  /** `""` for the root. */
  readonly path: string;
  /** The last path segment (`""` for the root). */
  readonly name: string;
  readonly parent: string | null;
  /** Direct subfolder paths, sorted. */
  readonly folders: readonly string[];
  /** Ids of the notes directly in this folder, sorted by path. */
  readonly notes: readonly string[];
  /** The folder's `index.md`, if it has one. */
  readonly index: string | null;
  /** The folder's `log.md`, if it has one. */
  readonly log: string | null;
}

/** A note that could not be added to the workspace (the rest still load). */
export interface WorkspaceIssue {
  /** `duplicate-path` includes paths that differ only in letter case. */
  readonly code: "invalid-path" | "not-markdown" | "duplicate-path" | "duplicate-id";
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

/**
 * An immutable view of a workspace. Update it with `upsertNote` and `removeNote`, which return a
 * new workspace and recompute only what the change can affect.
 */
export interface Workspace {
  readonly notes: ReadonlyMap<string, Note>;
  /** Note id by normalized path. */
  readonly paths: ReadonlyMap<string, string>;
  /** Every folder by path, the root (`""`) included. */
  readonly folders: ReadonlyMap<string, Folder>;
  /** Outgoing links by note id, in body order. */
  readonly links: ReadonlyMap<string, readonly ResolvedLink[]>;
  /** Incoming links by target note id, ordered by source path, line and column. */
  readonly backlinks: ReadonlyMap<string, readonly ResolvedLink[]>;
  /** Links that point at no note, by the id of the note they are in (see `ghostLinks`). */
  readonly ghosts: ReadonlyMap<string, readonly ResolvedLink[]>;
  readonly issues: readonly WorkspaceIssue[];
  /** Empty folders the caller asked to keep (see `createWorkspace`). */
  readonly extraFolders: readonly string[];
}
