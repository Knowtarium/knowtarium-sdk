import { CLIP_NOTE_TYPE, foldName, type Note } from "../../core/index.js";
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
export const FOLDER_MOST_USED = 3;
/** The most types and tags `list_workspaces` shows for a workspace, most used first. */
export const WORKSPACE_MOST_USED = 10;
/** The longest type or tag counted: longer ones are skipped, never cut. */
const MAX_VALUE_LENGTH = 48;
/** Control characters and bidirectional overrides: a value holding one is skipped. */
const CONTROL = /[\p{Cc}‪-‮⁦-⁩]/u;

/** Whether a note's `type` (a frontmatter value) says it is a clip from the web clipper. */
export function isClipType(type: unknown): boolean {
  return typeof type === "string" && type.trim() === CLIP_NOTE_TYPE;
}

/**
 * How note file names (`index.md` and `log.md` left out) are named, counted one at a time: the one
 * rule `create_note` also names a new note by (in lowercase with dashes exactly when it is
 * `dashed`). `dashed` when every name is lowercase words (letters or digits) joined by dashes and at
 * least one name has a dash (`travel-expenses.md`, `2024-10-25.md`); `title` when no name joins
 * words with dashes, so a folder of single words (`ideas.md`, `todo.md`, `会议记录.md`) is named
 * after its titles, as the web app would; `mixed` otherwise; null when there are no names.
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
    if (this.joined === 0) return "title";
    return this.kebab === this.names ? "dashed" : "mixed";
  }
}

/**
 * A type or tag as counted: trimmed (a tag without its leading `#`), or null when it is empty,
 * longer than `MAX_VALUE_LENGTH` or holds a control character. Values come from note frontmatter,
 * so anything that could break a listing or pass for something else is left out, never cut.
 */
function cleaned(value: string, tag: boolean): string | null {
  if (CONTROL.test(value)) return null;
  const text = tag ? value.trim().replace(/^#/, "").trim() : value.trim();
  return text === "" || text.length > MAX_VALUE_LENGTH ? null : text;
}

/**
 * Counts of values (a type, a tag), letter case ignored and each value once per note, shown under
 * the spelling most notes use.
 */
class Counts {
  private readonly counts = new Map<string, { notes: number; spellings: Map<string, number> }>();

  /** One note's values. */
  add(values: Iterable<string>): void {
    const own = new Map<string, string>();
    for (const value of values) {
      const key = foldName(value);
      if (!own.has(key)) own.set(key, value);
    }
    for (const [key, spelling] of own) {
      let entry = this.counts.get(key);
      if (entry === undefined) this.counts.set(key, (entry = { notes: 0, spellings: new Map() }));
      entry.notes += 1;
      entry.spellings.set(spelling, (entry.spellings.get(spelling) ?? 0) + 1);
    }
  }

  /**
   * The `max` most used, most used first, as a map of the spelling to how many notes use it. Ties
   * go by code unit order (not the locale's), so answers stay the same everywhere.
   */
  top(max: number): Record<string, number> {
    const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const shown: Record<string, number> = {};
    for (const [, entry] of [...this.counts]
      .sort(([a, x], [b, y]) => y.notes - x.notes || before(a, b))
      .slice(0, max)) {
      const [spelling] = [...entry.spellings].reduce((best, next) =>
        next[1] > best[1] || (next[1] === best[1] && next[0] < best[0]) ? next : best,
      );
      shown[spelling] = entry.notes;
    }
    return shown;
  }

  get size(): number {
    return this.counts.size;
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
    const type = note.fields.type === undefined ? null : cleaned(note.fields.type, false);
    this.types.add(type === null ? [] : [type]);
    this.tags.add(
      (note.fields.tags ?? []).flatMap((tag) => {
        const kept = cleaned(tag, true);
        return kept === null ? [] : [kept];
      }),
    );
  }
}

/**
 * The conventions one folder's own notes (not its subfolders') show, for `list_folders`, kept small
 * since every folder has one: how many notes it holds (`index.md` and `log.md` left out); its most
 * used `type` values and tags, each with how many notes use it (left out when there are none); how
 * its files are named (left out without notes); and `index` and `log` only when it has an
 * `index.md` or a `log.md`.
 */
export interface FolderStyle {
  readonly notes: number;
  readonly types?: Readonly<Record<string, number>>;
  readonly tags?: Readonly<Record<string, number>>;
  readonly naming?: NamingStyle;
  readonly index?: true;
  readonly log?: true;
}

/** A folder without notes. */
export const EMPTY_FOLDER_STYLE: FolderStyle = { notes: 0 };

/**
 * The conventions a workspace's notes show, for `list_workspaces`: its most used types and tags, how
 * its files are named, whether the root folder has an `index.md` and a `log.md` (null when the root
 * is outside this agent's folders), and how many folders have an `index.md`. Clips (`type: Clip`)
 * are left out, so a full inbox doesn't drown the person's own notes.
 */
export interface WorkspaceStyle {
  readonly types: Readonly<Record<string, number>>;
  readonly tags: Readonly<Record<string, number>>;
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
      if (!isClipType(note.fields.type)) workspace.add(note);
    }
  }
  const folders = new Map<FolderId, FolderStyle>();
  for (const id of new Set([...usage.keys(), ...indexes, ...logs])) {
    const folder = usage.get(id);
    const naming = folder?.naming.style ?? null;
    folders.set(id, {
      notes: folder?.notes ?? 0,
      ...(folder === undefined || folder.types.size === 0
        ? {}
        : { types: folder.types.top(FOLDER_MOST_USED) }),
      ...(folder === undefined || folder.tags.size === 0
        ? {}
        : { tags: folder.tags.top(FOLDER_MOST_USED) }),
      ...(naming === null ? {} : { naming }),
      ...(indexes.has(id) ? { index: true as const } : {}),
      ...(logs.has(id) ? { log: true as const } : {}),
    });
  }
  return {
    folders,
    workspace: {
      types: workspace.types.top(WORKSPACE_MOST_USED),
      tags: workspace.tags.top(WORKSPACE_MOST_USED),
      naming: workspace.naming.style,
      rootIndex: root === null ? null : indexes.has(root),
      rootLog: root === null ? null : logs.has(root),
      foldersWithIndex: indexes.size,
    },
  };
}
