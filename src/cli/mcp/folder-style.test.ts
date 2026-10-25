import { describe, expect, it } from "vitest";

import { createNote } from "../../core/index.js";
import type { FolderId } from "../../protocol/index.js";
import {
  EMPTY_FOLDER_STYLE,
  FOLDER_MOST_USED,
  stylesOf,
  WORKSPACE_MOST_USED,
} from "./folder-style.js";

const ROOT = "fld_root" as FolderId;
const NOTES = "fld_notes" as FolderId;
const OKF = "fld_okf" as FolderId;
const MIXED = "fld_mixed" as FolderId;
const INBOX = "fld_inbox" as FolderId;

/** A note in a folder, named `name`, with frontmatter lines `fields`. */
function note(folderId: FolderId, name: string, fields = "type: Note") {
  return {
    folderId,
    note: createNote({
      id: `${folderId}/${name}`,
      path: name,
      text: `---\n${fields}\n---\nBody\n`,
    }),
  };
}

describe("the conventions the notes show", () => {
  it("knows nothing about an empty workspace", () => {
    const { folders, workspace } = stylesOf([], ROOT);
    expect(folders.size).toBe(0);
    expect(workspace).toEqual({
      types: [],
      tags: [],
      naming: null,
      rootIndex: false,
      rootLog: false,
      foldersWithIndex: 0,
    });
    // the root outside the agent's folders: unknown, not absent
    expect(stylesOf([], null).workspace).toMatchObject({ rootIndex: null, rootLog: null });
    expect(EMPTY_FOLDER_STYLE).toMatchObject({ notes: 0, naming: null, index: false });
  });

  it("reads a web app folder: named after the titles, `type: Note`", () => {
    const { folders } = stylesOf(
      [
        note(NOTES, "Meeting notes.md"),
        note(NOTES, "Q3- plans - goals.md"),
        note(NOTES, "Ideas 2.md"),
        // a single lowercase word fits both styles
        note(NOTES, "todo.md"),
      ],
      null,
    );
    expect(folders.get(NOTES)).toEqual({
      notes: 4,
      types: [{ type: "Note", notes: 4 }],
      tags: [],
      naming: "title",
      index: false,
      log: false,
    });
  });

  it("reads a dash-named folder, and a mixed one", () => {
    const { folders } = stylesOf(
      [
        note(OKF, "travel-expenses.md", "type: Policy"),
        note(OKF, "leave.md", "type: Policy"),
        note(OKF, "how-to-claim.md", "type: Guide"),
        note(MIXED, "Travel expenses.md"),
        note(MIXED, "old-pricing.md"),
      ],
      null,
    );
    expect(folders.get(OKF)).toMatchObject({
      naming: "dashed",
      // most used first, then by name
      types: [
        { type: "Policy", notes: 2 },
        { type: "Guide", notes: 1 },
      ],
    });
    expect(folders.get(MIXED)?.naming).toBe("mixed");
  });

  it("finds index.md and log.md, which count as neither notes nor names", () => {
    const { folders, workspace } = stylesOf(
      [
        note(ROOT, "index.md", "type: Index"),
        note(ROOT, "log.md", "type: Log"),
        note(OKF, "index.md", "type: Index"),
        note(OKF, "leave.md", "type: Policy"),
        note(MIXED, "log.md", "type: Log"),
      ],
      ROOT,
    );
    expect(folders.get(ROOT)).toEqual({
      notes: 0,
      types: [],
      tags: [],
      naming: null,
      index: true,
      log: true,
    });
    expect(folders.get(OKF)).toMatchObject({ notes: 1, naming: "dashed", index: true, log: false });
    expect(folders.get(MIXED)).toMatchObject({ index: false, log: true });
    expect(workspace).toMatchObject({
      types: [{ type: "Policy", notes: 1 }],
      rootIndex: true,
      rootLog: true,
      foldersWithIndex: 2,
    });
  });

  it("caps the types and tags shown, most used first, each tag once per note", () => {
    const notes = Array.from({ length: 12 }, (_, i) =>
      note(
        NOTES,
        `Note ${String(i)}.md`,
        // tag-0 on every note, tag-1 on 11 of them, ..., tag-11 on one; the same tag twice counts once
        `type: Type ${String(i % 7)}\ntags: [${Array.from({ length: 12 - i }, (_, t) => `tag-${String(t)}`).join(", ")}, tag-0]`,
      ),
    );
    const { folders, workspace } = stylesOf(notes, null);
    const folder = folders.get(NOTES);
    expect(folder?.tags).toHaveLength(FOLDER_MOST_USED);
    expect(folder?.tags.slice(0, 3)).toEqual([
      { tag: "tag-0", notes: 12 },
      { tag: "tag-1", notes: 11 },
      { tag: "tag-2", notes: 10 },
    ]);
    expect(folder?.types).toHaveLength(FOLDER_MOST_USED);
    expect(workspace.tags).toHaveLength(WORKSPACE_MOST_USED);
    expect(workspace.types).toHaveLength(7);
    expect(workspace.tags.at(-1)).toEqual({ tag: "tag-9", notes: 3 });
  });

  it("leaves clips out of the workspace's summary, not out of their folder's", () => {
    const clips = Array.from({ length: 30 }, (_, i) =>
      note(INBOX, `Saved page ${String(i)}.md`, "type: Clip\ntags: [web]"),
    );
    const { folders, workspace } = stylesOf(
      [...clips, note(OKF, "leave.md", "type: Policy\ntags: [hr]")],
      null,
    );
    expect(folders.get(INBOX)).toMatchObject({ notes: 30, types: [{ type: "Clip", notes: 30 }] });
    expect(workspace).toMatchObject({
      types: [{ type: "Policy", notes: 1 }],
      tags: [{ tag: "hr", notes: 1 }],
      naming: "dashed",
    });
  });
});
