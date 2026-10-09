import {
  buildWorkspacePaths,
  createWorkspace,
  joinPath,
  type HumanEntryRef,
  restoreSearchIndex,
  SearchIndex,
  type Workspace,
  type WorkspaceLayout,
} from "../../core/index.js";
import type { FolderId, NoteId } from "../../protocol/index.js";
import type { NoteSnapshot, SyncEngine } from "../../client/index.js";

interface FolderEntry {
  readonly name: string;
  readonly parentId: FolderId | null;
  readonly createdAt: string | null;
}

/**
 * What the MCP server knows about one workspace, in memory: notes as the sync engine reports
 * them (verified and decrypted, with their file names), folders with their names, and a core
 * workspace and search index built from them on demand. Paths are workspace paths
 * (`<folder names>/<file name>`), as an export would write them.
 */
export class WorkspaceView {
  name: string | null = null;
  readonly notes = new Map<NoteId, NoteSnapshot>();
  readonly folders = new Map<FolderId, FolderEntry>();
  private built: { workspace: Workspace; layout: WorkspaceLayout } | undefined;
  private index: SearchIndex | undefined;

  constructor(
    engine: SyncEngine,
    /** The token's folders (and their subfolders); empty means the whole workspace. */
    private readonly scope: readonly FolderId[],
    private readonly ownerId: string,
  ) {
    engine.subscribe((event) => {
      if (event.type === "note") {
        if (event.note.text === null) this.notes.delete(event.note.noteId);
        else this.notes.set(event.note.noteId, event.note);
      } else if (event.type === "folder") {
        if (event.folder.deleted || event.folder.name === null) {
          this.folders.delete(event.folder.folderId);
        } else {
          this.folders.set(event.folder.folderId, {
            name: event.folder.name,
            parentId: event.folder.parentId,
            createdAt: event.folder.createdAt,
          });
        }
      } else if (event.type === "workspace") this.name = event.name;
      else return;
      this.built = undefined;
    });
  }

  /**
   * The layout: every folder's path from the folder names, every note's path from its folder and
   * its file name (stored inside its ciphertext; a legacy note without one is named after its
   * title), built by core's `buildWorkspacePaths`, and the core workspace of the notes in scope.
   */
  private build(): {
    workspace: Workspace;
    layout: WorkspaceLayout;
  } {
    if (this.built !== undefined) return this.built;
    const folders = [...this.folders].map(([id, folder]) => ({
      id,
      parentId: folder.parentId,
      name: folder.name,
      createdAt: folder.createdAt,
    }));
    const notes = [...this.notes.values()]
      .filter((note) => this.inScope(note.folderId))
      .map((note) => ({
        id: note.noteId,
        folderId: note.folderId,
        name: note.name,
        createdAt: note.createdAt,
        text: note.text ?? "",
      }));
    const layout = buildWorkspacePaths(folders, notes);
    const workspace = createWorkspace(
      notes.map((note) => ({
        id: note.id,
        path: layout.notes.get(note.id) ?? note.id,
        text: note.text,
      })),
      {
        folders: [...this.folders.keys()]
          .filter((id) => this.inScope(id))
          .map((id) => layout.folders.get(id) ?? id)
          .filter((path) => path !== ""),
      },
    );
    this.built = { workspace, layout };
    return this.built;
  }

  /** A folder's path (`""` for the root folder, its ID for a folder not synced yet). */
  folderPath(folderId: FolderId): string {
    return this.build().layout.folders.get(folderId) ?? folderId;
  }

  /** The folder at a path (letter case ignored), if any; `""` is the root folder. */
  folderAt(path: string): FolderId | null {
    const wanted = path.replace(/^\/+|\/+$/g, "").toLowerCase();
    for (const [id, folderPath] of this.build().layout.folders) {
      if (folderPath.toLowerCase() === wanted) return id as FolderId;
    }
    return null;
  }

  /**
   * Whether a folder is inside the token's scope, as the sync API decides it: a scoped folder's
   * subtree (folders with no parent are top level, so a scope listing the root folder holds only
   * the root's own notes). An empty scope is the whole workspace.
   */
  inScope(folderId: FolderId): boolean {
    if (this.scope.length === 0) return true;
    const seen = new Set<string>();
    for (let current: FolderId | null = folderId; current !== null && !seen.has(current);) {
      if (this.scope.includes(current)) return true;
      seen.add(current);
      current = this.folders.get(current)?.parentId ?? null;
    }
    return false;
  }

  /** The note at a path in a folder (letter case ignored), other than `except`. */
  noteNamed(folderId: FolderId, name: string, except?: NoteId): NoteSnapshot | undefined {
    const wanted = joinPath(this.folderPath(folderId), name).toLowerCase();
    for (const [id, path] of this.build().layout.notes) {
      if (id !== except && path.toLowerCase() === wanted) return this.notes.get(id as NoteId);
    }
    return undefined;
  }

  /** The core workspace of the notes in scope. */
  workspace(): Workspace {
    return this.build().workspace;
  }

  /** The search index over the notes in scope, kept in step with them. */
  search(): SearchIndex {
    const notes = [...this.workspace().notes.values()];
    if (this.index === undefined) this.index = SearchIndex.create(notes);
    else this.index.sync(notes);
    return this.index;
  }

  /** Restores the search index from its serialized form, catching up with the current notes. */
  restoreIndex(serialized: string): void {
    try {
      this.index = restoreSearchIndex(serialized, this.workspace().notes.values()).index;
    } catch {
      this.index = undefined;
    }
  }

  /** The note a reference names: an ID, or a display path (letter case ignored). */
  find(reference: string): NoteSnapshot | undefined {
    const byId = this.notes.get(reference as NoteId);
    if (byId !== undefined) return this.inScope(byId.folderId) ? byId : undefined;
    const wanted = reference.replace(/^\/+/, "").toLowerCase();
    for (const [id, path] of this.build().layout.notes) {
      if (path.toLowerCase() === wanted || path.toLowerCase() === `${wanted}.md`) {
        return this.notes.get(id as NoteId);
      }
    }
    return undefined;
  }

  /** A note's display path. */
  pathOf(noteId: string): string {
    return this.build().layout.notes.get(noteId) ?? noteId;
  }

  /**
   * The owner's `human:` entries the note's signed writes confirm, the rule the web app uses:
   * every verified `edited` or `approved` envelope of the owner (this version's and earlier ones,
   * as the sync engine collected them) confirms `human:<owner>` at exactly its `createdAt`, from
   * its version on. An entry at any other time, a future-dated one included, never counts, and an
   * applied check (`check_applied`) confirms none, so a person's entry stays confirmed after the
   * agent's check is written into the note (unless an agent wrote the version below the check:
   * then the engine reports none).
   */
  confirmedHumanEntries(note: NoteSnapshot): HumanEntryRef[] {
    return note.confirmations
      .filter((write) => write.by === this.ownerId)
      .map((write) => ({
        noteId: note.noteId,
        version: write.version,
        by: `human:${write.by}`,
        at: write.at,
      }));
  }
}
