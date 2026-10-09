import { describe, expect, it } from "vitest";

import { fixtureId, fixtureNotes, loadFixtureWorkspace } from "../../../test/fixture-workspace.js";
import { addVerified } from "../frontmatter/index.js";
import {
  backlinksTo,
  createWorkspace,
  findNotesByTitle,
  getFolder,
  getNote,
  getNoteByPath,
  ghostLinks,
  indexNoteOf,
  InvalidPathError,
  linksFrom,
  logNoteOf,
  notesInFolder,
  notesWithProblems,
  removeNote,
  upsertNote,
  WorkspaceError,
} from "../index.js";

const id = fixtureId;

describe("the fixture workspace", () => {
  const workspace = loadFixtureWorkspace();

  it("loads every note, the malformed one included", () => {
    expect(workspace.notes.size).toBe(fixtureNotes().length);
    expect(workspace.issues).toEqual([]);
    const broken = getNoteByPath(workspace, "notes/broken-yaml.md");
    expect(broken?.problems.map((problem) => problem.code)).toEqual(["frontmatter-yaml"]);
    expect(broken?.title).toBe("broken-yaml");
    expect(notesWithProblems(workspace).map((note) => note.path)).toEqual(["notes/broken-yaml.md"]);
  });

  it("builds the folder tree with index and log notes at two levels", () => {
    const root = getFolder(workspace, "");
    expect(root?.folders).toEqual(["decisions", "notes", "research"]);
    expect(root?.index).toBe(id("index.md"));
    expect(logNoteOf(workspace, "")?.title).toBe("Activity");
    expect(indexNoteOf(workspace, "research")?.path).toBe("research/index.md");
    expect(logNoteOf(workspace, "research")?.role).toBe("log");
    expect(indexNoteOf(workspace, "decisions")).toBeUndefined();
    expect(getFolder(workspace, "research")).toMatchObject({ name: "research", parent: "" });
    expect(notesInFolder(workspace, "decisions").map((note) => note.fileName)).toEqual([
      "annual-plans.md",
      "old-review.md",
    ]);
  });

  it("reads titles, OKF fields and custom keys", () => {
    const pricing = getNote(workspace, id("research/pricing.md"));
    expect(pricing?.title).toBe("Pricing model");
    expect(pricing?.fields.tags).toEqual(["pricing", "plans"]);
    expect(getNoteByPath(workspace, "getting-started.md")?.title).toBe("getting-started");
    const custom = getNoteByPath(workspace, "./notes\\custom-keys.md");
    expect(custom?.frontmatter["owner"]).toEqual({ name: "Sara", team: "growth" });
    expect(findNotesByTitle(workspace, "churn").map((note) => note.path)).toEqual([
      "research/churn.md",
    ]);
  });

  it("resolves links and collects backlinks", () => {
    const fromPricing = linksFrom(workspace, id("research/pricing.md"));
    expect(fromPricing.map((link) => [link.raw, link.resolution])).toEqual([
      ["[[annual-plans]]", { status: "note", noteId: id("decisions/annual-plans.md") }],
      ["[churn analysis](churn.md#september)", { status: "note", noteId: id("research/churn.md") }],
    ]);
    const toPricing = backlinksTo(workspace, id("research/pricing.md")).map((link) => link.from);
    expect(new Set(toPricing)).toEqual(
      new Set([
        id("log.md"),
        id("getting-started.md"),
        id("research/index.md"),
        id("research/churn.md"),
        id("research/competitors.md"),
        id("decisions/annual-plans.md"),
        id("notes/custom-keys.md"),
        id("notes/broken-yaml.md"),
      ]),
    );
    const churnLinks = linksFrom(workspace, id("research/churn.md")).map((link) => link.resolution);
    expect(churnLinks).toEqual([
      { status: "note", noteId: id("research/pricing.md") },
      { status: "asset", path: "references/billing-2026-09.csv" },
      { status: "asset", path: "assets/churn.png" },
    ]);
  });

  it("lists ghost links with their note and line", () => {
    expect(ghostLinks(workspace).map((link) => [link.from, link.raw, link.line])).toEqual([
      [id("decisions/annual-plans.md"), "[[Quarterly targets]]", 14],
      [id("getting-started.md"), "[onboarding checklist](onboarding.md)", 4],
    ]);
  });
});

describe("workspace updates", () => {
  const notes = [
    { id: "a", path: "a.md", text: "# A\n\n[[b]] and [[c]]\n" },
    { id: "b", path: "folder/b.md", text: "---\ntitle: Bee\n---\nBack to [[a]]\n" },
  ];

  it("returns new workspaces and leaves the old ones as they were", () => {
    const first = createWorkspace(notes);
    expect(ghostLinks(first).map((link) => link.target)).toEqual(["c"]);

    const second = upsertNote(first, { id: "c", path: "folder/c.md", text: "C\n" });
    expect(ghostLinks(second)).toEqual([]);
    expect(backlinksTo(second, "c").map((link) => link.from)).toEqual(["a"]);
    expect(first.notes.has("c")).toBe(false);
    expect(ghostLinks(first)).toHaveLength(1);

    const moved = upsertNote(second, { id: "c", path: "other/c.md", text: "C\n" });
    expect(getNoteByPath(moved, "folder/c.md")).toBeUndefined();
    expect(getFolder(moved, "other")?.notes).toEqual(["c"]);

    const third = removeNote(second, "b");
    expect(third.notes.has("b")).toBe(false);
    expect(backlinksTo(third, "a")).toEqual([]);
    expect(getFolder(third, "folder")?.notes).toEqual(["c"]);
    expect(removeNote(third, "missing")).toBe(third);
  });

  it("takes edited text back in", () => {
    const workspace = createWorkspace(notes);
    const b = getNote(workspace, "b");
    if (b === undefined) throw new Error("missing note");
    const edited = addVerified(b.parsed, "human:maya", "2026-09-30T12:00:00Z");
    const next = upsertNote(workspace, { id: "b", path: b.path, text: edited.text });
    expect(getNote(next, "b")?.fields.verified).toEqual([
      { by: "human:maya", at: "2026-09-30T12:00:00Z" },
    ]);
  });

  it("keeps empty folders the caller lists", () => {
    const workspace = createWorkspace(notes, { folders: ["empty/nested"] });
    expect(getFolder(workspace, "")?.folders).toEqual(["empty", "folder"]);
    expect(getFolder(workspace, "empty/nested")?.notes).toEqual([]);
  });

  it("leaves out notes with bad paths or duplicates, and refuses them on upsert", () => {
    const workspace = createWorkspace([
      ...notes,
      { id: "x", path: "../escape.md", text: "" },
      { id: "y", path: "picture.png", text: "" },
      { id: "a", path: "again.md", text: "" },
      { id: "z", path: "a.md", text: "" },
      { id: "w", path: "Folder/B.md", text: "" },
    ]);
    expect(workspace.notes.size).toBe(2);
    expect(workspace.issues.map((issue) => [issue.id, issue.code])).toEqual([
      ["x", "invalid-path"],
      ["y", "not-markdown"],
      ["a", "duplicate-id"],
      ["z", "duplicate-path"],
      ["w", "duplicate-path"],
    ]);
    expect(() => upsertNote(workspace, { id: "z", path: "a.md", text: "" })).toThrow(
      WorkspaceError,
    );
    expect(() => upsertNote(workspace, { id: "z", path: "/abs.md", text: "" })).toThrow(
      InvalidPathError,
    );
    expect(() => upsertNote(workspace, { id: "z", path: "A.md", text: "" })).toThrow(
      WorkspaceError,
    );
    const fixed = upsertNote(workspace, { id: "x", path: "escape.md", text: "" });
    expect(fixed.issues.map((issue) => issue.id)).toEqual(["y", "a", "z", "w"]);
    expect(removeNote(fixed, "a").issues.map((issue) => issue.id)).toEqual(["y", "z", "w"]);
  });
});
