import { describe, expect, it } from "vitest";

import { importBundle } from "./import.js";
import { ImportLimitError } from "./prepare.js";
import type { BundleFile, ImportResult } from "./types.js";

const person = "human:maya";
const at = "2026-10-01T12:00:00Z";
const obsidian: BundleFile = { path: ".obsidian/app.json", data: "{}" };

function text(result: ImportResult, path: string): string | undefined {
  return result.notes.find((note) => note.path === path)?.text;
}

describe("bundle root and source", () => {
  it("strips a shared top folder only when it holds the bundle's markers, and reports it", () => {
    const vault = importBundle(
      [
        { path: "MyVault/.obsidian/app.json", data: "{}" },
        { path: "MyVault/a.md", data: "A\n" },
      ],
      { person, at },
    );
    expect(vault.report).toMatchObject({ root: "MyVault", source: "obsidian" });
    expect(text(vault, "a.md")).toBeDefined();

    const plain = importBundle([{ path: "Notes/a.md", data: "A\n" }], { person, at });
    expect(plain.report.root).toBeNull();
    expect(plain.notes.map((note) => note.path)).toEqual(["Notes/a.md"]);
  });

  it("converts only a vault with .obsidian at its root that isn't OKF yet, and says why", () => {
    const nested = importBundle(
      [
        { path: "sub/.obsidian/app.json", data: "{}" },
        { path: "x.md", data: "X\n" },
      ],
      { person, at, stripRoot: false },
    );
    expect(nested.report.source).toBe("okf");
    expect(nested.report.sourceReason).toMatch(/No \.obsidian folder at the root/);

    const already = importBundle(
      [
        obsidian,
        { path: "index.md", data: "# Home\n\n* [A](a.md)\n" },
        { path: "a.md", data: "---\ntype: Note\n---\nA with [[index]]\n" },
      ],
      { person, at },
    );
    expect(already.report.source).toBe("okf");
    expect(already.report.sourceReason).toMatch(/already in OKF form/);
    expect(text(already, "a.md")).toBe("---\ntype: Note\n---\nA with [[index]]\n");
  });

  it("reports a removed leading slash and skips exported history once", () => {
    const result = importBundle(
      [
        { path: "/notes/a.md", data: "A\n" },
        { path: ".knowtarium/history/notes/a/1.md", data: "old\n" },
        { path: ".knowtarium/history/notes/a/2.md", data: "older\n" },
      ],
      { person, at, stripRoot: false },
    );
    expect(result.report.renamed).toEqual([
      { from: "/notes/a.md", to: "notes/a.md", reason: "A leading / was removed." },
    ]);
    expect(result.report.skipped).toEqual([
      { path: ".knowtarium/history/", reason: "2 past versions from an export, not imported." },
    ]);
  });

  it("refuses bundles over the limits before doing any work", () => {
    const files = [
      { path: "a.md", data: "A" },
      { path: "b.md", data: "B" },
    ];
    expect(() => importBundle(files, { person, at, maxFiles: 1 })).toThrow(ImportLimitError);
    expect(() => importBundle(files, { person, at, maxBytes: 1 })).toThrow(
      expect.objectContaining({ limit: "maxBytes" }),
    );
  });
});

describe("case-insensitive collisions", () => {
  it("reports folders differing only in case, and a file named like a folder", () => {
    const result = importBundle(
      [
        { path: "Notes/a.md", data: "A\n" },
        { path: "notes/b.md", data: "B\n" },
        { path: "thing", data: "file" },
        { path: "thing/c.md", data: "C\n" },
        { path: "ok/d.md", data: "D\n" },
      ],
      { person, at, stripRoot: false },
    );
    expect(result.notes.map((note) => note.path)).toEqual(["ok/d.md"]);
    expect(result.report.conflicts.map((conflict) => conflict.path).sort()).toEqual([
      "Notes/a.md",
      "notes/b.md",
      "thing",
      "thing/c.md",
    ]);
  });
});

describe("links", () => {
  it("keeps a markdown link's title and angle brackets when it rewrites the path", () => {
    const result = importBundle(
      [
        obsidian,
        { path: "log.md", data: "The log.\n" },
        {
          path: "a.md",
          data: "See [the log](log.md \"Our log\") and [again](<log.md>) and ![x](<log.md> 't').\n",
        },
      ],
      { person, at },
    );
    expect(text(result, "a.md")).toContain(
      "See [the log](log-note.md \"Our log\") and [again](<log-note.md>) and ![x](<log-note.md> 't').",
    );
  });

  it("reports what plain markdown can't carry", () => {
    const result = importBundle(
      [
        obsidian,
        { path: "B.md", data: "B\n" },
        {
          path: "a.md",
          data: '---\nrelated: "[[B]]"\n---\nJump to [[#Details]]. ![[B]]\n\n## Details\n',
        },
      ],
      { person, at },
    );
    expect(result.report.lossy).toEqual([
      { path: "a.md", link: "[[B]]", reason: "A wikilink in the frontmatter, kept as written." },
      {
        path: "a.md",
        link: "[[#Details]]",
        reason: "A link to a heading in the same note, kept as a wikilink.",
      },
      {
        path: "a.md",
        link: "![[B]]",
        reason: "An embedded note became a link: plain markdown can't embed a note.",
      },
    ]);
  });

  it("lists at most ten candidates for an ambiguous name, with the total", () => {
    const files: BundleFile[] = [obsidian, { path: "Home.md", data: "[[Same]]\n" }];
    for (let i = 0; i < 12; i++)
      files.push({ path: `f${String(i).padStart(2, "0")}/Same.md`, data: "x\n" });
    const [ambiguous] = importBundle(files, { person, at }).report.ambiguousLinks;
    expect(ambiguous?.candidates).toHaveLength(10);
    expect(ambiguous?.total).toBe(12);
  });
});
