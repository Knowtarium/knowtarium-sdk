import { InvalidPathError, normalizePath } from "../path/index.js";
import { buildFolders } from "./folders.js";
import { buildLinkGraph, type LinkGraph, patchLinkGraph } from "./graph.js";
import { createNote } from "./note.js";
import type { Note, NoteInput, Workspace, WorkspaceIssue } from "./types.js";

/** Thrown by `upsertNote` for a note that can't join the workspace. */
export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";

  constructor(readonly issue: WorkspaceIssue) {
    super(issue.message);
  }
}

export interface CreateWorkspaceOptions {
  /** Folder paths to show even when they hold no notes yet. */
  readonly folders?: Iterable<string>;
}

/** What a workspace keeps for incremental updates, out of its public shape. */
interface WorkspaceState {
  readonly graph: LinkGraph;
  /** Note id by case-folded path, to refuse paths that differ only in case. */
  readonly folded: ReadonlyMap<string, string>;
}

const states = new WeakMap<Workspace, WorkspaceState>();

function stateOf(workspace: Workspace): WorkspaceState {
  const state = states.get(workspace);
  if (state === undefined) throw new Error("This workspace was not built by createWorkspace");
  return state;
}

const fold = (path: string): string => path.toLowerCase();

function assemble(
  base: Omit<Workspace, "links" | "backlinks" | "ghosts">,
  state: WorkspaceState,
): Workspace {
  const workspace: Workspace = Object.freeze({
    ...base,
    links: state.graph.links,
    backlinks: state.graph.backlinks,
    ghosts: state.graph.ghosts,
  });
  states.set(workspace, state);
  return workspace;
}

function issueFor(input: NoteInput, error: InvalidPathError): WorkspaceIssue {
  const code = input.path.toLowerCase().endsWith(".md") ? "invalid-path" : "not-markdown";
  return { code, id: input.id, path: input.path, message: error.message };
}

/** Checks that no other note has the path, letter case aside. */
function conflictOf(folded: ReadonlyMap<string, string>, note: Note): WorkspaceIssue | undefined {
  const holder = folded.get(fold(note.path));
  if (holder === undefined || holder === note.id) return undefined;
  return {
    code: "duplicate-path",
    id: note.id,
    path: note.path,
    message: `Another note (${holder}) already has the path ${note.path} (letter case aside)`,
  };
}

/**
 * Builds a workspace from decrypted notes. Never throws for a single note: a note with a bad path,
 * or a duplicate id or path (paths that differ only in case count as duplicates), is left out and
 * listed in `issues`, and a note with broken frontmatter loads with its problems.
 */
export function createWorkspace(
  inputs: Iterable<NoteInput>,
  options: CreateWorkspaceOptions = {},
): Workspace {
  const extraFolders: string[] = [];
  const issues: WorkspaceIssue[] = [];
  for (const folder of options.folders ?? []) {
    try {
      extraFolders.push(normalizePath(folder));
    } catch (error) {
      if (!(error instanceof InvalidPathError)) throw error;
      issues.push({ code: "invalid-path", id: "", path: folder, message: error.message });
    }
  }
  const notes = new Map<string, Note>();
  const folded = new Map<string, string>();
  for (const input of inputs) {
    if (notes.has(input.id)) {
      issues.push({
        code: "duplicate-id",
        id: input.id,
        path: input.path,
        message: `Two notes have the id ${input.id}`,
      });
      continue;
    }
    let note: Note;
    try {
      note = createNote(input);
    } catch (error) {
      if (!(error instanceof InvalidPathError)) throw error;
      issues.push(issueFor(input, error));
      continue;
    }
    const conflict = conflictOf(folded, note);
    if (conflict !== undefined) {
      issues.push(conflict);
      continue;
    }
    notes.set(note.id, note);
    folded.set(fold(note.path), note.id);
  }
  const list = [...notes.values()];
  return assemble(
    {
      notes,
      paths: new Map(list.map((note) => [note.path, note.id])),
      folders: buildFolders(list, extraFolders),
      issues,
      extraFolders,
    },
    { graph: buildLinkGraph(list), folded },
  );
}

/** Applies one note changing, recomputing only what it can affect. */
function change(
  workspace: Workspace,
  before: Note | undefined,
  after: Note | undefined,
): Workspace {
  const state = stateOf(workspace);
  const id = (after ?? before)?.id ?? "";
  const notes = new Map(workspace.notes);
  if (after === undefined) notes.delete(id);
  else notes.set(id, after);

  const moved = before?.path !== after?.path;
  let { paths, folders } = workspace;
  let folded = state.folded;
  if (moved) {
    const nextPaths = new Map(paths);
    const nextFolded = new Map(folded);
    if (before !== undefined) {
      nextPaths.delete(before.path);
      nextFolded.delete(fold(before.path));
    }
    if (after !== undefined) {
      nextPaths.set(after.path, id);
      nextFolded.set(fold(after.path), id);
    }
    paths = nextPaths;
    folded = nextFolded;
    folders = buildFolders(notes.values(), workspace.extraFolders);
  }
  // issues about this id are stale once the note is in (or gone)
  const issues = workspace.issues.filter((issue) => issue.id !== id);
  return assemble(
    { notes, paths, folders, issues, extraFolders: workspace.extraFolders },
    { graph: patchLinkGraph(state.graph, notes, before, after), folded },
  );
}

/**
 * Adds a note or replaces the one with the same id (its text, its path, or both), returning a new
 * workspace. Throws `InvalidPathError` for a bad path and `WorkspaceError` when another note
 * already has the path (letter case aside).
 */
export function upsertNote(workspace: Workspace, input: NoteInput): Workspace {
  const note = createNote(input);
  const conflict = conflictOf(stateOf(workspace).folded, note);
  if (conflict !== undefined) throw new WorkspaceError(conflict);
  return change(workspace, workspace.notes.get(note.id), note);
}

/** Removes a note, returning a new workspace (the same one when the id is unknown). */
export function removeNote(workspace: Workspace, id: string): Workspace {
  const before = workspace.notes.get(id);
  if (before === undefined) return workspace;
  return change(workspace, before, undefined);
}
