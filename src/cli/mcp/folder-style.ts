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
/** The longest type or tag counted, in code points: longer ones are skipped, never cut. */
const MAX_VALUE_LENGTH = 48;
/**
 * Characters a value can't show plainly: control and format characters (bidirectional marks,
 * zero-width ones, the soft hyphen, Unicode tag characters, U+FEFF, U+FFF9..FFFB), line and
 * paragraph separators, and private-use ones. A value holding one is skipped, never stripped.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;

/**
 * Whether a note's `type` (a frontmatter value) says it is a clip from the web clipper, letter case
 * ignored as when types are counted.
 */
export function isClipType(type: unknown): boolean {
  return typeof type === "string" && foldName(type.trim()) === foldName(CLIP_NOTE_TYPE);
}

/** A type or tag with how many notes use it. */
export type Used = readonly [value: string, notes: number];

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
 * longer than `MAX_VALUE_LENGTH` or holds an invisible character. Values come from note
 * frontmatter, so anything that could break a listing or pass for something else is left out, never
 * cut.
 */
function cleaned(value: unknown, tag: boolean): string | null {
  // text, as the OKF fields read it (`tags: [2024]` is the tag `2024`)
  if (typeof value === "number" || typeof value === "boolean") value = String(value);
  if (typeof value !== "string" || INVISIBLE.test(value)) return null;
  const text = tag ? value.trim().replace(/^#/, "").trim() : value.trim();
  return text === "" || codePoints(text) > MAX_VALUE_LENGTH ? null : text;
}

/** How many code points a text holds (an emoji is one, though two UTF-16 units). */
function codePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * A note's tags, leniently: each usable element of its `tags` list (or the one tag a string names),
 * so one bad element (`null`, or the nested list an Obsidian `[[Link]]` makes) doesn't lose the
 * others, as it would in the OKF field.
 */
function tagsOf(note: Note): string[] {
  const raw = note.frontmatter["tags"];
  return (Array.isArray(raw) ? (raw as unknown[]) : [raw]).flatMap((tag) => {
    const kept = cleaned(tag, true);
    return kept === null ? [] : [kept];
  });
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
   * The `max` most used, most used first, each as its spelling and how many notes use it: pairs
   * in a list, not an object, whose keys would reorder (`2024` before `travel`) or vanish
   * (`__proto__`). Ties go by code unit order (not the locale's), so answers stay the same
   * everywhere.
   */
  top(max: number): Used[] {
    const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...this.counts]
      .sort(([a, x], [b, y]) => y.notes - x.notes || before(a, b))
      .slice(0, max)
      .map(([, entry]) => {
        const [spelling] = [...entry.spellings].reduce((best, next) =>
          next[1] > best[1] || (next[1] === best[1] && next[0] < best[0]) ? next : best,
        );
        return [spelling, entry.notes] as const;
      });
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
    const type = cleaned(note.fields.type, false);
    this.types.add(type === null ? [] : [type]);
    this.tags.add(tagsOf(note));
  }
}

/**
 * The conventions one folder's own notes (not its subfolders') show, for `list_folders`, kept small
 * since every folder has one: how many notes it holds (`index.md` and `log.md` left out); its most
 * used `type` values and tags as `[value, notes]` pairs, most used first (left out when there are
 * none); how its files are named (left out without notes); and `index` and `log` only when it has
 * an `index.md` or a `log.md`.
 */
export interface FolderStyle {
  readonly notes: number;
  readonly types?: readonly Used[];
  readonly tags?: readonly Used[];
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
  readonly types: readonly Used[];
  readonly tags: readonly Used[];
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
