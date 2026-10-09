import { describe, expect, it } from "vitest";

import { parseNote, readProvenance } from "../../core/index.js";
import { stripForeignHumanEntries } from "./proposals.js";

const base = `---
type: Note
title: Leave
generated: { by: claude-code/2.0, at: 2026-09-01T10:00:00Z }
verified:
  - { by: human:maya, at: 2026-09-02T10:00:00Z }
---
Everyone gets 25 days.
`;

const entries = (text: string) =>
  readProvenance(parseNote(text).frontmatter?.data ?? {}).verified.map(
    (entry) => `${entry.by} ${entry.at ?? ""}`,
  );

describe("stripping human entries a proposal added", () => {
  it("keeps the base's entries and the agent's own, drops new human: ones", () => {
    const proposed = base
      .replace(
        "  - { by: human:maya, at: 2026-09-02T10:00:00Z }\n",
        "  - { by: human:maya, at: 2026-09-02T10:00:00.000Z }\n  - { by: human:maya, at: 2026-10-01T09:00:00Z }\n  - { by: claude-code/2.1, at: 2026-10-01T09:00:00Z }\n  # a comment stays\n  - { by: human:someone, at: 2026-10-01T09:00:00Z }\n",
      )
      .replace("25 days", "30 days");
    const stripped = stripForeignHumanEntries(base, proposed);
    // the base's entry (written differently) stays, the agent's stays, the forged ones go
    expect(entries(stripped)).toEqual([
      "human:maya 2026-09-02T10:00:00.000Z",
      "claude-code/2.1 2026-10-01T09:00:00Z",
    ]);
    expect(stripped).toContain("# a comment stays");
    expect(stripped).toContain("30 days");
  });

  it("drops every human: entry from a proposed new note, and leaves clean text as it is", () => {
    const proposed = `---
type: Note
title: New
verified: [{ by: human:maya, at: 2026-10-01T09:00:00Z }, { by: claude-code/2.1, at: 2026-10-01T09:00:00Z }]
---
Body.
`;
    expect(entries(stripForeignHumanEntries(null, proposed))).toEqual([
      "claude-code/2.1 2026-10-01T09:00:00Z",
    ]);
    const only =
      "---\ntype: Note\nverified:\n  - { by: human:maya, at: 2026-10-01T09:00:00Z }\n---\nx\n";
    expect(stripForeignHumanEntries(null, only)).toBe("---\ntype: Note\n---\nx\n");
    expect(stripForeignHumanEntries(base, base)).toBe(base);
    expect(stripForeignHumanEntries(null, "No frontmatter.\n")).toBe("No frontmatter.\n");
  });
});

describe("stripping entries written to slip past the strip", () => {
  const humans = (text: string) =>
    readProvenance(parseNote(text).frontmatter?.data ?? {})
      .verified.filter((entry) => entry.kind === "human")
      .map((entry) => `${entry.by} ${entry.at ?? ""}`);
  const forged = "human:mallory";

  it.each([
    ["a padded actor", `verified:\n  - { by: "  ${forged}", at: 2026-10-01T09:00:00Z }\n`],
    ["one map instead of a list", `verified: { by: ${forged}, at: 2026-10-01T09:00:00Z }\n`],
    [
      "an alias in the list",
      `extra: &forged { by: ${forged}, at: 2026-10-01T09:00:00Z }\nverified:\n  - { by: human:maya, at: 2026-09-02T10:00:00Z }\n  - *forged\n`,
    ],
    [
      "the whole list behind an alias",
      `extra: &list [{ by: ${forged}, at: 2026-10-01T09:00:00Z }]\nverified: *list\n`,
    ],
    [
      "a merge key",
      `extra: &forged { by: ${forged}, at: 2026-10-01T09:00:00Z }\nverified:\n  - { <<: *forged }\n`,
    ],
  ])("%s", (_name, yaml) => {
    const proposed = `---\ntype: Note\ntitle: Leave\n${yaml}---\nBody.\n`;
    const stripped = stripForeignHumanEntries(base, proposed);
    // no human: entry the base didn't have survives, however it was written
    for (const entry of humans(stripped)) expect(entry).not.toContain(forged);
    expect(parseNote(stripped).problems).toEqual([]);
  });
});
