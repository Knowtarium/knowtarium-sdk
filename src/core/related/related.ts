// "Related notes": the short, ranked list of notes a change might affect or contradict, with the
// reason each is on it. The agent check and the MCP tools start from it. It works on the decrypted
// workspace in memory: links, tags and sources, plus the bodies of the notes for the
// changed-value signal. What it returns carries only titles and descriptions.
import { parseNote } from "../note/parse.js";
import type { Note, Workspace } from "../workspace/types.js";
import { changedValues, valueMatcher } from "./values.js";

/**
 * Why a note is related:
 *
 * - `links-to`: the note links to it
 * - `linked-from`: it links to the note
 * - `co-cited`: both link to the same note
 * - `shared-source`: both cite the same `sources` entry
 * - `shared-tag`: both have a tag
 * - `listed-in-folder-index`: the note's folder `index.md` lists it
 * - `mentions-changed-value`: its body still has a value the change removed or replaced
 * - `one-hop`: linked to or from one of the top results (only with `oneHop`)
 */
export type RelatedReasonKind =
  | "links-to"
  | "linked-from"
  | "co-cited"
  | "shared-source"
  | "shared-tag"
  | "listed-in-folder-index"
  | "mentions-changed-value"
  | "one-hop";

export interface RelatedReason {
  readonly kind: RelatedReasonKind;
  readonly weight: number;
  /** What they share: a tag, a source, a value, or the title of the note in between. */
  readonly detail: string;
}

export interface RelatedNote {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly description: string | null;
  readonly score: number;
  /** Strongest first. */
  readonly reasons: readonly RelatedReason[];
}

export interface RelatedOptions {
  /** At most this many notes (default 8). */
  readonly limit?: number;
  /**
   * The note's text before and after the change (decrypted history versions), to find notes that
   * still state a value the change removed or replaced.
   */
  readonly change?: { readonly before: string; readonly after: string };
  /** Also follow links one hop further from the top results (default false). */
  readonly oneHop?: boolean;
  /** Keep folder `index.md` and `log.md` notes in the results (default false: they list everything). */
  readonly includeReserved?: boolean;
}

/** The signal weights. A shared tag, source or link target counts less the more notes share it. */
export const RELATED_WEIGHTS = {
  linksTo: 3,
  linkedFrom: 3,
  coCited: 1,
  sharedSource: 2.5,
  sharedTag: 1.5,
  listedInFolderIndex: 0.5,
  mentionsChangedValue: 4,
  oneHop: 0.25,
} as const;

/** 1 when one other note shares it, less the more notes do. */
const rarity = (others: number): number => 1 / Math.log2(others + 1);

class Scores {
  readonly #reasons = new Map<string, RelatedReason[]>();

  constructor(
    private readonly workspace: Workspace,
    private readonly self: string,
  ) {}

  add(id: string, kind: RelatedReasonKind, weight: number, detail: string): void {
    if (id === this.self || !this.workspace.notes.has(id) || weight <= 0) return;
    const list = this.#reasons.get(id);
    const reason = { kind, weight, detail };
    if (list === undefined) this.#reasons.set(id, [reason]);
    else list.push(reason);
  }

  has(id: string): boolean {
    return this.#reasons.has(id);
  }

  ranked(keep: (note: Note) => boolean): RelatedNote[] {
    const list: RelatedNote[] = [];
    for (const [id, reasons] of this.#reasons) {
      const note = this.workspace.notes.get(id);
      if (note === undefined || !keep(note)) continue;
      list.push({
        id,
        path: note.path,
        title: note.title,
        description: note.fields.description ?? null,
        score: Math.round(reasons.reduce((sum, reason) => sum + reason.weight, 0) * 1000) / 1000,
        reasons: [...reasons].sort((a, b) => b.weight - a.weight),
      });
    }
    return list.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }
}

function linkTargets(workspace: Workspace, id: string): Set<string> {
  const targets = new Set<string>();
  for (const link of workspace.links.get(id) ?? []) {
    if (link.resolution.status === "note") targets.add(link.resolution.noteId);
  }
  return targets;
}

function linkSources(workspace: Workspace, id: string): Set<string> {
  return new Set((workspace.backlinks.get(id) ?? []).map((link) => link.from));
}

const titleOf = (workspace: Workspace, id: string): string => workspace.notes.get(id)?.title ?? id;

function sourceKeys(note: Note): string[] {
  return (note.fields.sources ?? []).flatMap((source) => {
    const key = source.resource ?? source.id;
    return key === undefined || key === "" ? [] : [key];
  });
}

/** Notes sharing a key with the note (tags, sources), with how many other notes share each. */
function sharing(
  workspace: Workspace,
  self: Note,
  keysOf: (note: Note) => readonly string[],
): Map<string, string[]> {
  const own = new Set(keysOf(self).map((key) => key.toLowerCase()));
  const holders = new Map<string, string[]>();
  if (own.size === 0) return holders;
  for (const note of workspace.notes.values()) {
    if (note.id === self.id) continue;
    for (const key of new Set(keysOf(note).map((value) => value.toLowerCase()))) {
      if (!own.has(key)) continue;
      const list = holders.get(key);
      if (list === undefined) holders.set(key, [note.id]);
      else list.push(note.id);
    }
  }
  return holders;
}

/**
 * The notes related to one note, strongest first, each with its title, description and reasons.
 * Returns `[]` when the note isn't in the workspace.
 */
export function relatedNotes(
  workspace: Workspace,
  noteId: string,
  options: RelatedOptions = {},
): RelatedNote[] {
  const note = workspace.notes.get(noteId);
  if (note === undefined) return [];
  const scores = new Scores(workspace, noteId);
  const w = RELATED_WEIGHTS;

  const targets = linkTargets(workspace, noteId);
  for (const target of targets)
    scores.add(target, "links-to", w.linksTo, titleOf(workspace, target));
  const sources = linkSources(workspace, noteId);
  for (const source of sources) {
    scores.add(source, "linked-from", w.linkedFrom, titleOf(workspace, source));
  }

  for (const target of targets) {
    if (workspace.notes.get(target)?.role !== "note") continue;
    const citing = [...linkSources(workspace, target)].filter((id) => id !== noteId);
    for (const id of citing) {
      scores.add(id, "co-cited", w.coCited * rarity(citing.length), titleOf(workspace, target));
    }
  }

  for (const [key, ids] of sharing(workspace, note, sourceKeys)) {
    for (const id of ids) scores.add(id, "shared-source", w.sharedSource * rarity(ids.length), key);
  }
  for (const [tag, ids] of sharing(workspace, note, (other) => other.fields.tags ?? [])) {
    for (const id of ids) scores.add(id, "shared-tag", w.sharedTag * rarity(ids.length), tag);
  }

  const index = workspace.folders.get(note.folder)?.index;
  if (index !== null && index !== undefined && index !== noteId) {
    const indexTitle = titleOf(workspace, index);
    for (const id of linkTargets(workspace, index)) {
      scores.add(id, "listed-in-folder-index", w.listedInFolderIndex, indexTitle);
    }
  }

  if (options.change !== undefined) {
    const before = parseNote(options.change.before).body;
    const after = parseNote(options.change.after).body;
    for (const value of changedValues(before, after)) {
      const matcher = valueMatcher(value);
      for (const other of workspace.notes.values()) {
        if (other.id !== noteId && matcher.test(other.body)) {
          scores.add(other.id, "mentions-changed-value", w.mentionsChangedValue, value.text);
        }
      }
    }
  }

  const keep = (other: Note) => options.includeReserved === true || other.role === "note";
  const limit = options.limit ?? 8;
  if (options.oneHop === true) {
    for (const top of scores.ranked(keep).slice(0, limit)) {
      const neighbours = new Set([
        ...linkTargets(workspace, top.id),
        ...linkSources(workspace, top.id),
      ]);
      for (const id of neighbours) {
        if (!scores.has(id)) scores.add(id, "one-hop", w.oneHop * top.score, top.title);
      }
    }
  }
  return scores.ranked(keep).slice(0, limit);
}
