import { describe, expect, it } from "vitest";

import { fixtureNotes } from "../../../test/fixture-workspace.js";
import { importFixture } from "../../../test/import-fixtures.js";
import { parseNote } from "../note/index.js";
import { readProvenance } from "../trust/index.js";
import { createWorkspace, ghostLinks, notesWithProblems } from "../workspace/index.js";
import { exportBundle, HISTORY_FOLDER } from "./export.js";
import { importBundle } from "./import.js";
import type { BundleFile, ImportResult } from "./types.js";

const person = "human:maya";
const at = "2026-10-01T12:00:00Z";

function text(result: ImportResult, path: string): string {
  const note = result.notes.find((entry) => entry.path === path);
  if (note === undefined) throw new Error(`no note at ${path}`);
  return note.text;
}

function workspaceOf(result: ImportResult) {
  return createWorkspace(
    result.notes.map((note) => ({ id: note.path, path: note.path, text: note.text })),
  );
}

describe("OKF import", () => {
  it("takes a plain bundle as it is, byte for byte, with nothing to report", () => {
    const files = importFixture("okf-plain");
    const result = importBundle(files, { person, at });
    expect(result.report).toMatchObject({
      source: "okf",
      notes: 6,
      attachments: 1,
      renamed: [],
      rewrittenLinks: [],
      skipped: [],
      conflicts: [],
      problems: [],
      generated: [],
    });
    for (const note of result.notes) {
      const original = files.find((file) => file.path === `okf-plain/${note.path}`);
      expect(note.text).toBe(original?.data);
    }
    expect(result.folders).toEqual(["", "assets", "policies"]);
    expect(notesWithProblems(workspaceOf(result))).toEqual([]);
  });

  it("reports conflicts instead of guessing", () => {
    const files: BundleFile[] = [
      { path: "Notes/Plan.md", data: "one\n" },
      { path: "notes/plan.md", data: "two\n" },
      { path: "../outside.md", data: "x\n" },
      { path: "docs/con.md", data: "x\n" },
      { path: "bad.md", data: new Uint8Array([0xff, 0xfe, 0x00]) },
      { path: "ok.md", data: "fine\n" },
      { path: "empty/", data: "" },
      { path: ".DS_Store", data: "x" },
    ];
    const result = importBundle(files, { person, at, stripRoot: false });
    expect(result.notes.map((note) => note.path)).toEqual(["ok.md"]);
    expect(result.report.conflicts.map((conflict) => conflict.path).sort()).toEqual(
      ["../outside.md", "Notes/Plan.md", "bad.md", "docs/con.md", "notes/plan.md"].sort(),
    );
    expect(result.report.skipped).toEqual([
      { path: ".DS_Store", reason: "A hidden file, not part of the bundle." },
    ]);
    expect(result.folders).toEqual(["", "empty"]);
  });
});

describe("Obsidian import", () => {
  const result = importBundle(importFixture("obsidian-messy"), { person, at });

  it("converts wikilinks and embeds to relative markdown links", () => {
    expect(text(result, "Welcome.md")).toContain(
      "Start with [Pricing](Pricing.md) or [the launch](Projects/Launch%20plan.md).\n\n" +
        "![diagram.png](attachments/diagram.png)\n\n" +
        "The quarterly numbers are in [Q3 report.pdf](attachments/Q3%20report.pdf), and the old " +
        "home page is [the projects home](Projects/index-note.md).\n\n" +
        "Inline code keeps `[[not a link]]` as it is.\n",
    );
    expect(text(result, "Projects/Launch plan.md")).toContain(
      "[Pricing](../Pricing.md)\n\nThe price table is at [Pricing](../Pricing.md#^price-table). " +
        "Nobody wrote [[Ghost note]] yet.\n",
    );
    expect(text(result, "Pricing.md")).toContain(
      "See [Annual plans](Annual%20plans.md#Why%20yearly) and the table below.",
    );
  });

  it("adds the missing OKF fields and keeps every existing key byte for byte", () => {
    expect(
      text(result, "Pricing.md").startsWith(
        "---\ntags: [pricing, sales]\naliases: [Plans]\nowner: maya\n" +
          "type: Note\ntitle: Pricing\n" +
          "description: Pro is 14 EUR a month since September. See Annual plans and the table below.\n" +
          `generated: { by: ${person}, at: ${at} }\n---\n`,
      ),
    ).toBe(true);
    // an existing type and generated stay as written; stale_after is never added
    const annual = parseNote(text(result, "Annual plans.md")).frontmatter?.data ?? {};
    expect(annual).toMatchObject({ type: "Decision", title: "Annual plans" });
    expect(readProvenance(annual).generated?.by).toBe("claude-code/2.1");
    for (const note of result.notes) {
      expect(parseNote(note.text).frontmatter?.data ?? {}).not.toHaveProperty("stale_after");
    }
  });

  it("renames reserved names, and writes an index per folder and a root log", () => {
    expect(result.report.renamed).toEqual([
      {
        from: "Projects/index.md",
        to: "Projects/index-note.md",
        reason: "OKF reserves index.md and log.md.",
      },
    ]);
    expect(text(result, "Projects/index.md")).toBe(
      "# Projects\n\n" +
        "* [Launch plan](Launch%20plan.md) - We launch on a Tuesday.\n" +
        "* [Projects home](index-note.md) - Everything we are building: Launch plan.\n",
    );
    expect(text(result, "log.md")).toBe(
      `# Log\n\n## 2026-10-01\n\n* Imported from Obsidian by ${person}: 7 notes.\n`,
    );
    expect(result.report.generated).toEqual([
      "index.md",
      "Daily/index.md",
      "Projects/index.md",
      "Templates/index.md",
      "log.md",
    ]);
  });

  it("leaves settings out, and daily notes, templates and canvases alone", () => {
    expect(result.report.skipped.map((entry) => entry.path)).toEqual([
      ".obsidian/app.json",
      ".obsidian/daily-notes.json",
      ".obsidian/plugins/dataview/manifest.json",
      ".obsidian/templates.json",
      ".trash/Old idea.md",
    ]);
    expect(result.report.untouched.map((entry) => entry.path)).toEqual([
      "Board.canvas",
      "Daily/2026-09-30.md",
      "Templates/Meeting.md",
    ]);
    expect(text(result, "Daily/2026-09-30.md")).toBe("Talked about [[Pricing]] today.\n");
    expect(result.attachments.map((file) => file.path)).toEqual([
      "attachments/diagram.png",
      "attachments/Q3 report.pdf",
      "Board.canvas",
    ]);
  });

  it("imports with zero problems and no new ghost links", () => {
    const workspace = workspaceOf(result);
    const converted = [...workspace.notes.values()].filter(
      (note) => !note.path.startsWith("Templates/") && !note.path.startsWith("Daily/"),
    );
    expect(converted.filter((note) => note.problems.length > 0)).toEqual([]);
    expect(result.report.problems).toEqual([]);
    expect(result.report.unresolvedLinks).toEqual([
      { path: "Projects/Launch plan.md", link: "[[Ghost note]]" },
    ]);
    const ghosts = ghostLinks(workspace)
      .filter((link) => !link.from.startsWith("Daily/") && !link.embed)
      .map((link) => `${link.from}: ${link.raw}`);
    expect(ghosts).toEqual(["Projects/Launch plan.md: [[Ghost note]]"]);
  });
});

describe("edge cases", () => {
  const result = importBundle(importFixture("edge-cases"), { person, at });

  it("reports a reserved name whose new name is taken, and doesn't import it", () => {
    expect(result.report.conflicts).toEqual([
      {
        path: "index.md",
        reason:
          "OKF reserves this name, and index-note.md already exists: rename one of them and import again.",
        paths: ["index.md", "index-note.md"],
      },
    ]);
    expect(text(result, "index-note.md")).toContain("Another note that already uses the new name.");
    expect(text(result, "index.md")).toMatch(/^# edge-cases\n/); // the generated index
  });

  it("resolves duplicate names the way Obsidian does, and reports them", () => {
    expect(result.report.ambiguousLinks).toEqual([
      {
        path: "Home.md",
        link: "[[Meeting]]",
        chosen: "A/Meeting.md",
        candidates: ["A/Meeting.md", "B/Meeting.md"],
        total: 2,
      },
    ]);
    expect(text(result, "A/Meeting.md")).toContain(
      "See [log](log-note.md) and the [same log](log-note.md) and [Meeting](Meeting.md#Action%20items).",
    );
    expect(text(result, "A/Meeting.md")).toContain("| me  | [m](Meeting.md) |");
  });

  it("encodes awkward names and keeps fenced code and broken frontmatter as they are", () => {
    const home = text(result, "Home.md");
    expect(home).toContain("[Plan (draft)](Plan%20%28draft%29.md)");
    expect(home).toContain("```\n[[inside a fence]] stays as it is\n```");
    expect(result.report.unresolvedLinks.map((link) => link.link)).toEqual([
      "[[index]]",
      "[[Missing]]",
    ]);
    expect(text(result, "Broken.md")).toBe(
      "---\ntitle: [unclosed\n---\nThe frontmatter is broken, and [[Home]] stays as it is.\n",
    );
    expect(result.report.problems.map((entry) => entry.path)).toEqual(["Broken.md"]);
    expect(parseNote(text(result, "A/log-note.md")).frontmatter?.data).toMatchObject({
      title: "log",
    });
  });

  it("keeps CRLF line endings and a byte order mark", () => {
    const crlf = importBundle(
      [
        { path: ".obsidian/app.json", data: "{}" },
        { path: "Win.md", data: "﻿First line with [[Other]].\r\nSecond line.\r\n" },
        { path: "Other.md", data: "x\n" },
      ],
      { person, at },
    );
    const win = text(crlf, "Win.md");
    expect(win.startsWith("﻿---\r\ntype: Note\r\n")).toBe(true);
    expect(win.endsWith("First line with [Other](Other.md).\r\nSecond line.\r\n")).toBe(true);
  });
});

describe("export", () => {
  it("round-trips the fixture workspace byte for byte", () => {
    const notes = fixtureNotes();
    const bundle = exportBundle({ notes: createWorkspace(notes) }, { addMissingIndexes: false });
    const back = importBundle([...bundle.files], { person, at, source: "okf", stripRoot: false });
    expect(back.notes.map((note) => [note.path, note.text])).toEqual(
      notes.map((note) => [note.path, note.text]),
    );
    expect(back.report.conflicts).toEqual([]);
  });

  it("round-trips an imported bundle with its attachments", () => {
    const first = importBundle(importFixture("okf-plain"), { person, at });
    const bundle = exportBundle({
      notes: first.notes.map((note) => ({ id: note.path, ...note })),
      attachments: first.attachments,
    });
    // a folder holding only attachments has nothing to list, so it gets no index
    expect(bundle.generated).toEqual([]);
    const again = importBundle([...bundle.files], { person, at, stripRoot: false });
    expect(again.notes).toEqual(first.notes.map((note) => ({ ...note, source: note.path })));
    expect(again.attachments.map((file) => file.data)).toEqual(
      first.attachments.map((file) => file.data),
    );
  });

  it("exports one folder, empty folders and past versions", () => {
    const bundle = exportBundle(
      {
        notes: [
          { id: "a", path: "research/a.md", text: "---\ntitle: A\n---\nA\n" },
          { id: "b", path: "other/b.md", text: "B\n" },
        ],
        folders: ["research/empty"],
        history: [{ path: "research/a.md", versions: [{ version: 1, text: "old\n" }] }],
      },
      { folder: "research" },
    );
    expect(bundle.files.map((file) => file.path)).toEqual([
      `${HISTORY_FOLDER}/a/1.md`,
      "a.md",
      "index.md",
    ]);
    expect(bundle.folders).toEqual(["", "empty"]);
    expect(bundle.files.find((file) => file.path === "index.md")?.data).toBe(
      "# Index\n\n* [A](a.md)\n",
    );
  });
});
