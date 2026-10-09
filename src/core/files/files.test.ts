import { describe, expect, it } from "vitest";

import { importFixture } from "../../../test/import-fixtures.js";
import { exportBundle, importBundle } from "../bundle/index.js";
import { normalizePath } from "../path/index.js";
import { createWorkspace } from "../workspace/index.js";
import {
  buildWorkspacePaths,
  decodeNoteFile,
  foldName,
  mergeNoteNames,
  encodeNoteFile,
  NoteFileError,
  noteNameFromTitle,
  normalizeNoteName,
  safeSegment,
  planImport,
  type StoredFolder,
  type StoredNote,
  uniqueName,
} from "./index.js";

describe("the note file", () => {
  it("is canonical JSON with the name and the raw text", () => {
    const text = '---\ntitle: "Q3"\n---\nBody with "quotes" and ünïcode\n';
    const plaintext = encodeNoteFile({ name: "q3.md", text });
    expect(plaintext).toBe(`{"name":"q3.md","text":${JSON.stringify(text)},"v":1}`);
    expect(decodeNoteFile(plaintext)).toEqual({ name: "q3.md", text });
  });

  it("refuses bare text: every note version stores its name", () => {
    for (const text of ["---\ntitle: A\n---\nx", "{not json", '{"title":"no v"}', ""]) {
      expect(() => decodeNoteFile(text)).toThrow(NoteFileError);
    }
  });

  it("accepts only the canonical form", () => {
    for (const plaintext of [
      '{"v":1,"name":"a.md","text":"x"}',
      '{"name":"a.md", "text":"x","v":1}',
      '{"name":"\\u0061.md","text":"x","v":1}',
      '{"name":"a.md","text":"\\u0078","v":1}',
      '{"name":"a.md","text":"x","v":1.0}',
    ]) {
      expect(() => decodeNoteFile(plaintext)).toThrow(NoteFileError);
    }
  });

  it("refuses unknown versions, extra keys and names that aren't normalized note names", () => {
    for (const plaintext of [
      '{"name":"a.md","text":"x","v":2}',
      '{"name":"a.md","text":"x","v":"1"}',
      '{"name":"a.md","text":"x","v":1,"folder":"b"}',
      '{"name":"a.md","v":1}',
      '{"name":"b/a.md","text":"x","v":1}',
      '{"name":"a.txt","text":"x","v":1}',
      '{"name":"nul.md","text":"x","v":1}',
      '{"name":"cafe\\u0301.md","text":"x","v":1}',
    ]) {
      expect(() => decodeNoteFile(plaintext)).toThrow(NoteFileError);
    }
  });

  it("normalizes names with the workspace path rules", () => {
    expect(normalizeNoteName("café.md")).toBe("café.md");
    expect(normalizeNoteName("./Index.MD")).toBe("Index.MD");
    for (const bad of ["", "a/b.md", "../a.md", "a.md.", "c:a.md", "a", `${"x".repeat(260)}.md`]) {
      expect(() => normalizeNoteName(bad)).toThrow();
    }
    expect(noteNameFromTitle("Q3: pricing / plans?")).toBe("Q3- pricing - plans-.md");
    expect(noteNameFromTitle("   ")).toBe("note.md");
  });
});

describe("workspace paths", () => {
  const folders: StoredFolder[] = [
    { id: "fld_root", parentId: null, name: "" },
    { id: "fld_a", parentId: null, name: "Research" },
    { id: "fld_b", parentId: "fld_a", name: "Q3: plans" },
    { id: "fld_c", parentId: null, name: "research" },
  ];

  it("joins folder names and note names, keeping valid names exactly", () => {
    const notes: StoredNote[] = [
      { id: "note_1", folderId: "fld_root", name: "index.md", text: "" },
      { id: "note_2", folderId: "fld_a", name: "Pricing (old).md", text: "" },
      { id: "note_3", folderId: "fld_b", name: "a.md", text: "" },
    ];
    const layout = buildWorkspacePaths(folders, notes);
    expect([...layout.notes.values()]).toEqual([
      "index.md",
      "Research/Pricing (old).md",
      "Research/Q3- plans/a.md",
    ]);
    // two sibling folders differing only in case are told apart
    expect(layout.folders.get("fld_c")).toBe("research (fld_c)");
    expect(layout.renamed).toEqual([
      { id: "fld_c", path: "research (fld_c)", reason: "duplicate" },
    ]);
  });

  it("names legacy notes after their titles and tells duplicates apart", () => {
    const layout = buildWorkspacePaths(folders, [
      { id: "note_9", folderId: "fld_a", name: null, text: "---\ntitle: Pricing\n---\n" },
      { id: "note_1", folderId: "fld_a", name: "pricing.md", text: "" },
      { id: "note_2", folderId: "fld_a", name: "Pricing.md", text: "" },
    ]);
    expect(layout.notes.get("note_1")).toBe("Research/pricing.md");
    expect(layout.notes.get("note_2")).toBe("Research/Pricing (note_2).md");
    expect(layout.notes.get("note_9")).toBe("Research/Pricing (note_9).md");
    expect(layout.renamed.map((entry) => entry.id)).toEqual(["fld_c", "note_2", "note_9"]);
  });

  it("never gives two items the same path, however the names line up", () => {
    // ids sharing their last six characters, and a note stored under a suffixed name already
    const notes: StoredNote[] = [
      { id: "note_aaa123456", folderId: "fld_a", name: "a.md", text: "" },
      { id: "note_bbb123456", folderId: "fld_a", name: "a.md", text: "" },
      { id: "note_ccc123456", folderId: "fld_a", name: "a.md", text: "" },
      { id: "note_ddd", folderId: "fld_a", name: "a (123456).md", text: "" },
      { id: "note_eee", folderId: "fld_a", name: "a (note_ccc123456).md", text: "" },
      { id: "note_fff", folderId: "fld_a", name: "Q3- plans", text: "" },
    ];
    const extra: StoredFolder[] = [
      ...folders,
      { id: "fld_d", parentId: "fld_a", name: "Q3- plans" },
      { id: "fld_e", parentId: "fld_a", name: "Q3: plans" },
    ];
    const layout = buildWorkspacePaths(extra, notes);
    const paths = [...layout.folders.values(), ...layout.notes.values()].map((path) =>
      path.toLowerCase(),
    );
    expect(new Set(paths).size).toBe(paths.length);
    // the oldest by ID keeps the plain name
    expect(layout.notes.get("note_aaa123456")).toBe("Research/a.md");
  });

  it("lets the first signed write keep a contested name", () => {
    const layout = buildWorkspacePaths(folders, [
      {
        id: "note_1",
        folderId: "fld_a",
        name: "a.md",
        text: "",
        createdAt: "2026-10-01T10:00:00Z",
      },
      {
        id: "note_2",
        folderId: "fld_a",
        name: "a.md",
        text: "",
        createdAt: "2026-09-01T10:00:00Z",
      },
      { id: "note_0", folderId: "fld_a", name: "a.md", text: "", createdAt: null },
    ]);
    expect(layout.notes.get("note_2")).toBe("Research/a.md");
    expect(layout.notes.get("note_1")).toBe("Research/a (note_1).md");
    expect(layout.notes.get("note_0")).toBe("Research/a (note_0).md");
  });

  it("keeps one root folder and shows folders stored under it at the top level", () => {
    const layout = buildWorkspacePaths(
      [
        { id: "fld_root", parentId: null, name: "", createdAt: "2026-09-01T00:00:00Z" },
        { id: "fld_late", parentId: null, name: "", createdAt: "2026-09-02T00:00:00Z" },
        { id: "fld_x", parentId: "fld_root", name: "Inside" },
      ],
      [{ id: "note_1", folderId: "fld_late", name: "a.md", text: "" }],
    );
    expect(layout.root).toBe("fld_root");
    expect(layout.folders.get("fld_x")).toBe("Inside");
    expect(layout.folders.get("fld_late")).toBe("fld_late");
    expect(layout.notes.get("note_1")).toBe("fld_late/a.md");
  });

  it("merges names: the renaming side wins, a legacy base counts their name, both is a conflict", () => {
    expect(mergeNoteNames({ base: "a.md", mine: "b.md", theirs: "a.md" })).toEqual({
      name: "b.md",
      conflict: null,
    });
    expect(mergeNoteNames({ base: null, mine: "pricing.md", theirs: "prices.md" })).toEqual({
      name: "prices.md",
      conflict: null,
    });
    expect(mergeNoteNames({ base: "a.md", mine: "b.md", theirs: "c.md" })).toEqual({
      name: "c.md",
      conflict: { mine: "b.md", theirs: "c.md" },
    });
    expect(uniqueName("a.md", ["A.md", "a (note_1).md"], "note_1")).toBe("a (note_1 2).md");
  });

  it("cuts long names at a code point", () => {
    const name = noteNameFromTitle("😀".repeat(100));
    expect(name.endsWith(".md")).toBe(true);
    expect(name.includes("\uFFFD")).toBe(false);
    expect(Array.from(name.slice(0, -3)).every((char) => char === "😀")).toBe(true);
  });
});

describe("import and export through stored names", () => {
  it("gives back every note at its exact path, byte for byte", () => {
    for (const fixture of ["okf-plain", "edge-cases", "obsidian-messy"] as const) {
      const imported = importBundle(importFixture(fixture), {
        person: "human:acc_1",
        at: "2026-10-01T12:00:00Z",
      });
      const plan = planImport(imported);
      // what the sync API would store: folders by name under their parents, notes by name
      const ids = new Map(
        plan.folders.map((folder, index) => [folder.path, `fld_${String(index)}`]),
      );
      const folders: StoredFolder[] = plan.folders.map((folder) => ({
        id: ids.get(folder.path) ?? "",
        parentId: folder.parent === null ? null : (ids.get(folder.parent) ?? null),
        name: folder.name,
      }));
      const notes: StoredNote[] = plan.notes.map((note, index) => ({
        id: `note_${String(index)}`,
        folderId: ids.get(note.folder) ?? "",
        name: note.name,
        text: note.text,
      }));
      const layout = buildWorkspacePaths(folders, notes);
      expect(layout.renamed).toEqual([]);
      const workspace = createWorkspace(
        notes.map((note) => ({
          id: note.id,
          path: layout.notes.get(note.id) ?? "",
          text: note.text,
        })),
      );
      const exported = exportBundle({ notes: workspace }, { addMissingIndexes: false });
      const files = new Map(exported.files.map((file) => [file.path, file.data]));
      for (const note of imported.notes) expect(files.get(note.path)).toBe(note.text);
      expect(files.size).toBe(imported.notes.length);
    }
  });
});

describe("hostile names", () => {
  // mulberry32: a small seeded generator with a full period, so a failure reproduces
  let seed = 20261001;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const pieces = [
    "aux",
    "AUX",
    "con",
    "nul",
    "com1",
    "lpt9",
    "prn",
    ".txt",
    ".md",
    ".tar.gz",
    ".",
    "..",
    "...",
    " ",
    "  ",
    "\t",
    "\n",
    "\u0000",
    "\u001f",
    "\u007f",
    "\u0085",
    "‮",
    "⁦",
    "​",
    "/",
    "\\",
    ":",
    "*",
    "?",
    '"',
    "<",
    ">",
    "|",
    "é",
    "😀",
    "日本語",
    "ﬁ",
    "a",
    "Q3 plan",
    "index",
    "log",
    "#",
    "%20",
    "~",
    "-",
    "_",
    "\ud800",
    // NFD forms and case folding beyond ASCII: é, Å, ß and its capital, the Kelvin sign, dotless i
    "A\u030a",
    "\u00c5",
    "\u00df",
    "\u1e9e",
    "SS",
    "\u212a",
    "K",
    "\u0131",
    "I",
  ];
  const hostile = () =>
    Array.from({ length: 1 + Math.floor(random() * 8) }, () => pick(pieces)).join("") +
    (random() < 0.1 ? "😀".repeat(80) : "");
  const isNormalized = (path: string) => {
    try {
      return normalizePath(path) === path;
    } catch {
      return false;
    }
  };

  it("makes every name a segment the path rules accept", () => {
    for (const name of ["aux.txt", "con", "Nul.md", "lpt1.tar.gz", "aux.txt.", " aux "]) {
      expect(isNormalized(safeSegment(name, "x"))).toBe(true);
      expect(() => normalizeNoteName(noteNameFromTitle(name))).not.toThrow();
    }
    expect(safeSegment("aux.txt", "x")).toBe("_aux.txt");
    expect(noteNameFromTitle("aux.txt")).toBe("_aux.txt.md");
    for (let i = 0; i < 3000; i++) {
      const name = hostile();
      const segment = safeSegment(name, "fallback");
      expect(isNormalized(segment) && !segment.includes("/"), JSON.stringify(name)).toBe(true);
      expect(() => normalizeNoteName(noteNameFromTitle(name)), JSON.stringify(name)).not.toThrow();
    }
  });

  it("never fails building paths, and every path is valid and unique", () => {
    for (let round = 0; round < 200; round++) {
      const folders: StoredFolder[] = Array.from({ length: 6 }, (_, index) => ({
        id: random() < 0.2 ? hostile() : `fld_${String(index)}`,
        parentId:
          index === 0 || random() < 0.3 ? null : `fld_${String(Math.floor(random() * index))}`,
        name: random() < 0.15 ? "" : hostile(),
      }));
      const notes: StoredNote[] = Array.from({ length: 10 }, (_, index) => ({
        id: random() < 0.2 ? hostile() : `note_${String(index)}`,
        folderId: random() < 0.1 ? "fld_missing" : pick(folders).id,
        name: random() < 0.4 ? null : random() < 0.5 ? `${hostile()}.md` : hostile(),
        text:
          random() < 0.5 ? `---\ntitle: ${JSON.stringify(hostile())}\n---\n` : `# ${hostile()}\n`,
      }));
      // parent cycles: two folders that are each other's parent, and one that is its own
      if (round % 3 === 0) {
        folders.push(
          { id: "fld_cycle_a", parentId: "fld_cycle_b", name: hostile() },
          { id: "fld_cycle_b", parentId: "fld_cycle_a", name: hostile() },
          { id: "fld_self", parentId: "fld_self", name: hostile() },
        );
        notes.push({ id: "note_in_cycle", folderId: "fld_cycle_a", name: null, text: "# x" });
      }
      const layout = buildWorkspacePaths(folders, notes);
      const paths = [...layout.folders.values(), ...layout.notes.values()].filter(
        (path) => path !== "",
      );
      for (const path of paths) expect(isNormalized(path), JSON.stringify(path)).toBe(true);
      for (const path of layout.notes.values()) {
        expect(() => normalizeNoteName(path.split("/").at(-1) ?? "")).not.toThrow();
      }
      const lower = paths.map(foldName);
      expect(new Set(lower).size).toBe(lower.length);
    }
  });
});
