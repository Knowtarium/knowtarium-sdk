// The link graph of a workspace: outgoing links, backlinks and ghost links, built in full once
// and then patched per change. A change re-resolves only the notes whose links can see it,
// found through the reverse index from lookup keys to the notes whose links use them.
import {
  createLinkIndex,
  type LinkIndex,
  linkKeys,
  resolveLink,
  targetKeys,
  updateLinkIndex,
} from "../links/resolve.js";
import type { ResolvedLink } from "../links/types.js";
import type { Note } from "./types.js";

export interface LinkGraph {
  readonly index: LinkIndex;
  readonly links: ReadonlyMap<string, readonly ResolvedLink[]>;
  readonly backlinks: ReadonlyMap<string, readonly ResolvedLink[]>;
  readonly ghosts: ReadonlyMap<string, readonly ResolvedLink[]>;
  /** Ids of the notes whose links use each lookup key. */
  readonly usedBy: ReadonlyMap<string, ReadonlySet<string>>;
}

function resolveNote(index: LinkIndex, note: Note): ResolvedLink[] {
  return note.linkRefs.map((ref) => ({
    ...ref,
    from: note.id,
    resolution: resolveLink(index, ref, note.path),
  }));
}

function keysOf(note: Note): Set<string> {
  return new Set(note.linkRefs.flatMap((ref) => linkKeys(ref, note.path)));
}

/** Resolves every note's links against the whole workspace. */
export function buildLinkGraph(notes: readonly Note[]): LinkGraph {
  const index = createLinkIndex(notes);
  const links = new Map<string, readonly ResolvedLink[]>();
  const backlinks = new Map<string, ResolvedLink[]>();
  const ghosts = new Map<string, readonly ResolvedLink[]>();
  const usedBy = new Map<string, Set<string>>();
  for (const note of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
    const resolved = resolveNote(index, note);
    links.set(note.id, resolved);
    const ghostLinks = resolved.filter((link) => link.resolution.status === "ghost");
    if (ghostLinks.length > 0) ghosts.set(note.id, ghostLinks);
    for (const link of resolved) {
      if (link.resolution.status !== "note") continue;
      const incoming = backlinks.get(link.resolution.noteId);
      if (incoming === undefined) backlinks.set(link.resolution.noteId, [link]);
      else incoming.push(link);
    }
    for (const key of keysOf(note)) {
      const users = usedBy.get(key);
      if (users === undefined) usedBy.set(key, new Set([note.id]));
      else users.add(note.id);
    }
  }
  return { index, links, backlinks, ghosts, usedBy };
}

/** A note's identity for link resolution changed (added, removed, moved or retitled). */
function identityChanged(before: Note | undefined, after: Note | undefined): boolean {
  return before?.path !== after?.path || before?.title !== after?.title;
}

function updateUsedBy(
  usedBy: ReadonlyMap<string, ReadonlySet<string>>,
  before: Note | undefined,
  after: Note | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const id = (after ?? before)?.id;
  if (id === undefined) return usedBy;
  const oldKeys = before === undefined ? new Set<string>() : keysOf(before);
  const newKeys = after === undefined ? new Set<string>() : keysOf(after);
  const next = new Map(usedBy);
  for (const key of oldKeys) {
    if (newKeys.has(key)) continue;
    const users = new Set(next.get(key));
    users.delete(id);
    if (users.size === 0) next.delete(key);
    else next.set(key, users);
  }
  for (const key of newKeys) {
    if (oldKeys.has(key)) continue;
    next.set(key, new Set(next.get(key)).add(id));
  }
  return next;
}

/**
 * Patches the graph for one note changing (`before` to `after`; either may be missing for an add
 * or a removal). `notes` is the workspace after the change.
 */
export function patchLinkGraph(
  graph: LinkGraph,
  notes: ReadonlyMap<string, Note>,
  before: Note | undefined,
  after: Note | undefined,
): LinkGraph {
  const changedId = (after ?? before)?.id;
  if (changedId === undefined) return graph;
  const renamed = identityChanged(before, after);
  const index = renamed ? updateLinkIndex(graph.index, before, after) : graph.index;

  // the notes to re-resolve: the changed note, plus every note with a link that could have
  // pointed at its old identity or can point at its new one
  const sources = new Set<string>();
  if (after !== undefined) sources.add(after.id);
  if (renamed) {
    const keys = [
      ...(before === undefined ? [] : targetKeys(before)),
      ...(after === undefined ? [] : targetKeys(after)),
    ];
    for (const key of keys) for (const id of graph.usedBy.get(key) ?? []) sources.add(id);
    if (after === undefined) sources.delete(changedId);
  }

  const links = new Map(graph.links);
  const ghosts = new Map(graph.ghosts);
  const touched = new Set<string>();
  const added: ResolvedLink[] = [];
  const removedSource = after === undefined ? changedId : undefined;
  const collectOld = (id: string) => {
    for (const link of graph.links.get(id) ?? []) {
      if (link.resolution.status === "note") touched.add(link.resolution.noteId);
    }
  };
  if (removedSource !== undefined) {
    collectOld(removedSource);
    links.delete(removedSource);
    ghosts.delete(removedSource);
  }
  for (const id of sources) {
    const note = notes.get(id);
    if (note === undefined) continue;
    collectOld(id);
    const resolved = resolveNote(index, note);
    links.set(id, resolved);
    const ghostLinks = resolved.filter((link) => link.resolution.status === "ghost");
    if (ghostLinks.length > 0) ghosts.set(id, ghostLinks);
    else ghosts.delete(id);
    for (const link of resolved) {
      if (link.resolution.status !== "note") continue;
      touched.add(link.resolution.noteId);
      added.push(link);
    }
  }

  const backlinks = new Map(graph.backlinks);
  if (removedSource !== undefined) touched.add(removedSource);
  const pathOf = (id: string) => notes.get(id)?.path ?? "";
  for (const target of touched) {
    const kept = (graph.backlinks.get(target) ?? []).filter(
      (link) => !sources.has(link.from) && link.from !== removedSource,
    );
    const incoming = [
      ...kept,
      ...added.filter(
        (link) => link.resolution.status === "note" && link.resolution.noteId === target,
      ),
    ];
    if (incoming.length === 0 || !notes.has(target)) {
      backlinks.delete(target);
      continue;
    }
    incoming.sort(
      (a, b) =>
        pathOf(a.from).localeCompare(pathOf(b.from)) || a.line - b.line || a.column - b.column,
    );
    backlinks.set(target, incoming);
  }

  return { index, links, backlinks, ghosts, usedBy: updateUsedBy(graph.usedBy, before, after) };
}
