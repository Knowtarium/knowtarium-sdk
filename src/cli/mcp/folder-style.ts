import { CLIP_NOTE_TYPE, type Note } from "../../core/index.js";
import type { FolderId } from "../../protocol/index.js";

/** Lowercase words joined by dashes, ending in `.md`, as many OKF bundles name their notes. */
export const KEBAB_NAME = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*\.md$/u;

/**
 * How a folder's note files are named: `dashed`, lowercase words joined by dashes
 * (`travel-expenses.md`); `title`, after the note's title, spaces and capitals kept, as the web app
 * names notes (`Travel expenses.md`); or `mixed`.
 */
export type NamingStyle = "title" | "dashed" | "mixed";

/** The most types and tags `list_folders` shows for one folder, most used first. */
export const FOLDER_MOST_USED = 5;
/** The most types and tags `list_workspaces` shows for a workspace, most used first. */
export const WORKSPACE_MOST_USED = 10;

/**
 * How note file names (`index.md` and `log.md` left out) are named, counted one at a time: the one
 * rule `create_note` also names a new note by (in lowercase with dashes exactly when it is
 * `dashed`). `dashed` when every name is lowercase words joined by dashes; `title` when no name
 * joins words with dashes (a single lowercase word, `pricing.md`, fits both styles, so it never
 * makes a folder `mixed`); `mixed` otherwise; null when there are no names.
 */
class NameTally {
  private names = 0;
  private kebab = 0;
  private joined = 0;

  add(name: string): void {
    this.names += 1;
    if (!KEBAB_NAME.test(name)) return;
    this.kebab += 1;
    if (name.includes("-")) this.joined += 1;
  }

  get style(): NamingStyle | null {
    if (this.names === 0) return null;
    if (this.kebab === this.names) return "dashed";
    return this.joined === 0 ? "title" : "mixed";
  }
}

/** Counts of values (a type, a tag), each value once per note. */
class Counts {
  private readonly counts = new Map<string, number>();

  add(value: string): void {
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
  }

  /** The `max` most used, most used first (ties by name, so answers stay the same). */
  top(max: number): { value: string; notes: number }[] {
    return [...this.counts]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .slice(0, max)
      .map(([value, notes]) => ({ value, notes }));
  }
}

/** What a folder's notes use: kept while counting, shown capped. */
class Usage {
  notes = 0;
  readonly types = new Counts();
  readonly tags = new Counts();
  readonly naming = new NameTally();

  add(note: Note): void {
    this.notes += 1;
    this.naming.add(note.fileName);
    const type = note.fields.type?.trim();
    if (type !== undefined && type !== "") this.types.add(type);
    const tags = new Set((note.fields.tags ?? []).map((tag) => tag.trim()));
    for (const tag of tags) if (tag !== "") this.tags.add(tag);
  }

  shown(max: number) {
    return {
      types: this.types.top(max).map(({ value, notes }) => ({ type: value, notes })),
      tags: this.tags.top(max).map(({ value, notes }) => ({ tag: value, notes })),
      naming: this.naming.style,
    };
  }
}

/**
 * The conventions one folder's own notes (not its subfolders') show, for `list_folders`: how many
 * notes it holds (`index.md` and `log.md` left out), its most used `type` values and tags with how
 * many notes use each, how its files are named, and whether it has an `index.md` and a `log.md`.
 */
export interface FolderStyle {
  readonly notes: number;
  readonly types: readonly { type: string; notes: number }[];
  readonly tags: readonly { tag: string; notes: number }[];
  readonly naming: NamingStyle | null;
  readonly index: boolean;
  readonly log: boolean;
}

/** A folder without notes. */
export const EMPTY_FOLDER_STYLE: FolderStyle = {
  notes: 0,
  types: [],
  tags: [],
  naming: null,
  index: false,
  log: false,
};

/**
 * The conventions a workspace's notes show, for `list_workspaces`: its most used types and tags, how
 * its files are named, whether the root folder has an `index.md` and a `log.md` (null when the root
 * is outside this agent's folders), and how many folders have an `index.md`. Clips (`type: Clip`)
 * are left out, so a full inbox doesn't drown the person's own notes.
 */
export interface WorkspaceStyle {
  readonly types: readonly { type: string; notes: number }[];
  readonly tags: readonly { tag: string; notes: number }[];
  readonly naming: NamingStyle | null;
  readonly rootIndex: boolean | null;
  readonly rootLog: boolean | null;
  readonly foldersWithIndex: number;
}

/** Every folder's conventions, by folder ID, and the workspace's. */
export interface Conventions {
  readonly folders: ReadonlyMap<FolderId, FolderStyle>;
  readonly workspace: WorkspaceStyle;
}

/**
 * Every folder's and the workspace's conventions from the notes in scope, in one pass and without
 * their bodies: computed locally from the decrypted notes, never sent anywhere. `root` is the root
 * folder when it is in scope, else null.
 */
export function stylesOf(
  notes: Iterable<{ readonly folderId: FolderId; readonly note: Note }>,
  root: FolderId | null,
): Conventions {
  const usage = new Map<FolderId, Usage>();
  const indexes = new Set<FolderId>();
  const logs = new Set<FolderId>();
  const workspace = new Usage();
  for (const { folderId, note } of notes) {
    if (note.role === "index") indexes.add(folderId);
    else if (note.role === "log") logs.add(folderId);
    else {
      let folder = usage.get(folderId);
      if (folder === undefined) usage.set(folderId, (folder = new Usage()));
      folder.add(note);
      if (note.fields.type?.trim() !== CLIP_NOTE_TYPE) workspace.add(note);
    }
  }
  const folders = new Map<FolderId, FolderStyle>();
  for (const id of new Set([...usage.keys(), ...indexes, ...logs])) {
    const folder = usage.get(id);
    folders.set(id, {
      notes: folder?.notes ?? 0,
      ...(folder?.shown(FOLDER_MOST_USED) ?? { types: [], tags: [], naming: null }),
      index: indexes.has(id),
      log: logs.has(id),
    });
  }
  return {
    folders,
    workspace: {
      ...workspace.shown(WORKSPACE_MOST_USED),
      rootIndex: root === null ? null : indexes.has(root),
      rootLog: root === null ? null : logs.has(root),
      foldersWithIndex: indexes.size,
    },
  };
}
