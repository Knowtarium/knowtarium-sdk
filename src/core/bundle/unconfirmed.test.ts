import { describe, expect, it } from "vitest";

import { parseNote } from "../note/parse.js";
import { readProvenance } from "../trust/provenance.js";
import { exportBundle } from "./export.js";

const note = `---
type: Note
title: Leave
verified:
  - { by: human:maya, at: 2026-09-02T10:00:00Z }
  - { by: claude-code/2.1, at: 2026-09-03T10:00:00Z }
  - { by: human:maya, at: 2099-01-01T00:00:00Z }
---
Everyone gets 25 days.
`;

const fileText = (bundle: ReturnType<typeof exportBundle>, path: string) =>
  String(bundle.files.find((file) => file.path === path)?.data ?? "");

const verifiedOf = (text: string) =>
  readProvenance(parseNote(text).frontmatter?.data ?? {}).verified.map((entry) => entry.by);

describe("exporting from the app", () => {
  const confirmed = new Map([
    ["policies/leave.md", [{ by: "human:maya", at: "2026-09-02T10:00:00.000Z" }]],
  ]);
  const input = {
    notes: [{ id: "note_1", path: "policies/leave.md", text: note }],
    history: [{ path: "policies/leave.md", versions: [{ version: 1, text: note }] }],
  };

  it("strips human: entries no signed write confirms, by default, in past versions too", () => {
    const bundle = exportBundle(input, { confirmedHumanEntries: confirmed });
    const text = fileText(bundle, "policies/leave.md");
    expect(verifiedOf(text)).toEqual(["human:maya", "claude-code/2.1"]);
    expect(text).not.toContain("2099");
    expect(fileText(bundle, ".knowtarium/history/policies/leave/1.md")).not.toContain("2099");
  });

  it("annotates them instead when asked, where OKF readers don't trust them", () => {
    const bundle = exportBundle(input, {
      confirmedHumanEntries: confirmed,
      unconfirmedHumanEntries: "annotate",
    });
    const text = fileText(bundle, "policies/leave.md");
    expect(verifiedOf(text)).toEqual(["human:maya", "claude-code/2.1"]);
    expect(parseNote(text).frontmatter?.data["unconfirmed_verified"]).toEqual([
      { by: "human:maya", at: "2099-01-01T00:00:00Z" },
    ]);
  });

  it("leaves plain OKF exports as they are", () => {
    expect(fileText(exportBundle(input), "policies/leave.md")).toBe(note);
  });
});

describe("exporting entries written to slip past the strip", () => {
  const forged = "human:mallory";
  it.each([
    `verified:\n  - { by: " ${forged}", at: 2026-10-01T09:00:00Z }\n`,
    `verified: { by: ${forged}, at: 2026-10-01T09:00:00Z }\n`,
    `extra: &forged { by: ${forged}, at: 2026-10-01T09:00:00Z }\nverified:\n  - *forged\n`,
  ])("strips %j", (yaml) => {
    const text = `---\ntype: Note\n${yaml}---\nBody.\n`;
    const bundle = exportBundle(
      { notes: [{ id: "note_1", path: "a.md", text }] },
      { confirmedHumanEntries: new Map() },
    );
    const exported = String(bundle.files.find((file) => file.path === "a.md")?.data ?? "");
    const humans = readProvenance(parseNote(exported).frontmatter?.data ?? {}).verified.filter(
      (entry) => entry.kind === "human",
    );
    expect(humans).toEqual([]);
  });
});

describe("exporting a note with `verified` written twice", () => {
  const forged = "human:mallory";
  const exportText = (text: string, mode: "strip" | "annotate" = "strip") =>
    String(
      exportBundle(
        { notes: [{ id: "note_1", path: "a.md", text }] },
        {
          confirmedHumanEntries: new Map([
            ["a.md", [{ by: "human:maya", at: "2026-09-02T10:00:00.000Z" }]],
          ]),
          unconfirmedHumanEntries: mode,
        },
      ).files.find((file) => file.path === "a.md")?.data ?? "",
    );

  it.each([
    [
      "the forged entry in the first pair (a reader keeping the first value)",
      `verified:\n  - { by: ${forged}, at: 2026-10-01T09:00:00Z }\ntitle: Leave\nverified:\n  - { by: human:maya, at: 2026-09-02T10:00:00Z }\n`,
    ],
    [
      "the forged entry in the last pair",
      `verified: []\ntitle: Leave\nverified: [{ by: ${forged}, at: 2026-10-01T09:00:00Z }]\n`,
    ],
    [
      "one verified, another key written twice",
      `title: Leave\ntitle: Again\nverified:\n  - { by: ${forged}, at: 2026-10-01T09:00:00Z }\n`,
    ],
  ])("removes every verified pair: %s", (_name, yaml) => {
    for (const mode of ["strip", "annotate"] as const) {
      const exported = exportText(`---\ntype: Note\n${yaml}---\nBody.\n`, mode);
      // annotate may keep it apart, under a key OKF readers ignore
      if (mode === "strip") expect(exported).not.toContain(forged);
      expect(exported).not.toMatch(/^verified:/m);
      expect(exported).toContain("type: Note\n");
      expect(exported.endsWith("---\nBody.\n")).toBe(true);
    }
  });

  it("keeps a note with only confirmed entries as it is, repeated keys and all", () => {
    const text = `---\ntitle: A\ntitle: B\nverified:\n  - { by: human:maya, at: 2026-09-02T10:00:00Z }\n---\nBody.\n`;
    expect(exportText(text)).toBe(text);
  });

  it("returns text unchanged only when the frontmatter can't be parsed at all", () => {
    const text = `---\nverified: [{ by: ${forged}\ntitle: [unclosed\n---\nBody.\n`;
    expect(exportText(text)).toBe(text);
  });
});

describe("a note whose verified can't be cleaned", () => {
  const anchored = `---\ntype: Note\nverified: &shared [{ by: human:mallory, at: 2026-10-01T09:00:00Z }]\nreviewers: *shared\n---\nBody.\n`;
  const clean = `---\ntype: Note\ntitle: Fine\n---\nBody.\n`;

  it("is left out and reported, and the rest of the export goes on", () => {
    const bundle = exportBundle(
      {
        notes: [
          { id: "note_1", path: "a/anchored.md", text: anchored },
          { id: "note_2", path: "a/fine.md", text: clean },
        ],
        history: [{ path: "a/anchored.md", versions: [{ version: 1, text: anchored }] }],
      },
      { confirmedHumanEntries: new Map() },
    );
    const paths = bundle.files.map((file) => file.path);
    expect(paths).toContain("a/fine.md");
    expect(paths).not.toContain("a/anchored.md");
    expect(paths.some((path) => path.startsWith(".knowtarium/history/"))).toBe(false);
    expect(bundle.withheld.map(({ path, version }) => ({ path, version }))).toEqual([
      { path: "a/anchored.md", version: null },
      { path: "a/anchored.md", version: 1 },
    ]);
    expect(bundle.withheld[0]?.reason).toMatch(/frontmatter/);
    // the generated index doesn't link the note left out
    expect(String(bundle.files.find((file) => file.path === "a/index.md")?.data)).not.toContain(
      "anchored",
    );
  });

  it("is exported as it is without confirmedHumanEntries", () => {
    const bundle = exportBundle({ notes: [{ id: "note_1", path: "a.md", text: anchored }] });
    expect(bundle.withheld).toEqual([]);
    expect(bundle.files.map((file) => file.path)).toContain("a.md");
  });
});
