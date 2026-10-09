import { describe, expect, it } from "vitest";

import { parseNote } from "../note/index.js";
import { readProvenance } from "../trust/index.js";
import { lineDiff, wordDiff } from "./diff.js";
import { mergeNotes, resolveMerge, withConflictMarkers } from "./merge.js";
import { restoreText } from "./restore.js";

const note = (frontmatter: string, body: string) => `---\n${frontmatter}---\n${body}`;

const base = note(
  "title: Pricing # keep this comment\ntype: concept\ngenerated: { by: human:a, at: 2026-09-01T10:00:00Z }\nverified:\n  - { by: human:a, at: 2026-09-01T10:00:00Z }\n",
  "# Pricing\n\nWe charge $20.\n\nPre-order is $10.\n\nNo free tier.\n",
);

describe("diffs", () => {
  it("diffs lines and rebuilds both sides", () => {
    const after = base.replace("We charge $20.", "We charge $24.");
    const diff = lineDiff(base, after);
    expect(diff).toMatchObject({ added: 1, removed: 1, unchanged: false });
    const side = (kind: "added" | "removed") =>
      diff.parts
        .filter((part) => part.kind === "same" || part.kind === kind)
        .map((part) => part.text)
        .join("");
    expect(side("removed")).toBe(base);
    expect(side("added")).toBe(after);
    expect(lineDiff(base, base).unchanged).toBe(true);
  });

  it("diffs words inside a line", () => {
    const diff = wordDiff("We charge $20 a month.", "We charge $24 a year.");
    expect(diff.parts.filter((part) => part.kind !== "same").map((part) => part.text)).toEqual([
      "20",
      "24",
      "month",
      "year",
    ]);
    expect(diff).toMatchObject({ added: 2, removed: 2 });
  });
});

describe("three-way merge", () => {
  it("merges edits to different parts of the body", () => {
    const mine = base.replace("We charge $20.", "We charge $24.");
    const theirs = base.replace("No free tier.", "No free tier, ever.");
    const merge = mergeNotes({ base, mine, theirs });
    expect(merge.conflicts).toEqual([]);
    expect(merge.text).toBe(
      base
        .replace("We charge $20.", "We charge $24.")
        .replace("No free tier.", "No free tier, ever."),
    );
  });

  it("reports the same line changed differently as a conflict, and resolves it", () => {
    const mine = base.replace("We charge $20.", "We charge $24.");
    const theirs = base.replace("We charge $20.", "We charge $22.");
    const merge = mergeNotes({ base, mine, theirs });
    expect(merge.text).toBeNull();
    expect(merge.conflicts).toEqual([
      {
        kind: "conflict",
        region: "body",
        base: "We charge $20.\n",
        mine: "We charge $24.\n",
        theirs: "We charge $22.\n",
      },
    ]);
    expect(resolveMerge(merge, () => "mine")).toBe(mine);
    expect(resolveMerge(merge, () => "theirs")).toBe(theirs);
    expect(resolveMerge(merge, () => ({ text: "We charge $23.\n" }))).toBe(
      base.replace("We charge $20.", "We charge $23."),
    );
    expect(withConflictMarkers(merge)).toContain(
      "<<<<<<< mine\nWe charge $24.\n||||||| base\nWe charge $20.\n=======\nWe charge $22.\n>>>>>>> theirs\n",
    );
  });

  it("takes a field only one side changed, byte for byte, with its comment", () => {
    const mine = base.replace("type: concept", "type: decision");
    const theirs = base
      .replace("title: Pricing # keep this comment", "title: 'Pricing, 2026' # keep this comment")
      .replace("No free tier.", "No free tier, ever.");
    const merge = mergeNotes({ base, mine, theirs });
    expect(merge.text).toBe(theirs.replace("type: concept", "type: decision"));
  });

  it("keeps both sides' new verified checks", () => {
    const mine = base.replace(
      "verified:\n  - { by: human:a, at: 2026-09-01T10:00:00Z }\n",
      "verified:\n  - { by: human:a, at: 2026-09-01T10:00:00Z }\n  - { by: human:b, at: 2026-09-02T10:00:00Z }\n",
    );
    const theirs = base.replace(
      "verified:\n  - { by: human:a, at: 2026-09-01T10:00:00Z }\n",
      "verified:\n  - { by: human:a, at: 2026-09-01T10:00:00Z }\n  - { by: claude-code/2.1, at: 2026-09-02T11:00:00Z }\n",
    );
    const merge = mergeNotes({ base, mine, theirs });
    expect(merge.conflicts).toEqual([]);
    const verified = readProvenance(parseNote(merge.text ?? "").frontmatter?.data ?? {}).verified;
    expect(verified.map((entry) => entry.by)).toEqual(["human:a", "claude-code/2.1", "human:b"]);
  });

  it("reports a field both sides changed differently as a field conflict", () => {
    const mine = base.replace("type: concept", "type: decision");
    const theirs = base.replace("type: concept", "type: process");
    const merge = mergeNotes({ base, mine, theirs });
    expect(merge.conflicts).toEqual([
      {
        kind: "conflict",
        region: "frontmatter",
        field: "type",
        base: "type: concept\n",
        mine: "type: decision\n",
        theirs: "type: process\n",
      },
    ]);
    expect(resolveMerge(merge, () => "mine")).toBe(mine);
  });

  it("keeps a field one side removed out, and adds one only mine added", () => {
    const mine = base.replace("type: concept\n", "type: concept\nstatus: draft\n");
    const theirs = base.replace("type: concept\n", "");
    const merge = mergeNotes({ base, mine, theirs });
    expect(merge.text).toContain("status: draft\n");
    expect(merge.text).not.toContain("type: concept");
  });

  it("falls back to lines when the frontmatter can't be read", () => {
    const broken = "---\ntitle: [unclosed\n---\nBody line\n";
    const merge = mergeNotes({
      base: broken,
      mine: broken.replace("Body line", "Mine"),
      theirs: broken,
    });
    expect(merge.text).toBe(broken.replace("Body line", "Mine"));
  });

  it("merges two new notes with no base", () => {
    const merge = mergeNotes({ base: null, mine: "Same\n", theirs: "Same\n" });
    expect(merge.text).toBe("Same\n");
    expect(mergeNotes({ base: null, mine: "A\n", theirs: "B\n" }).conflicts).toHaveLength(1);
  });

  it("merges two-way when the base is unknown: nothing one side has is taken for granted", () => {
    // the same sides that merge cleanly three-way above
    const mine = base
      .replace("type: concept\n", "type: concept\nstatus: draft\n")
      .replace(
        "verified:\n  - { by: human:a, at: 2026-09-01T10:00:00Z }\n",
        "verified:\n  - { by: human:a, at: 2026-09-01T10:00:00Z }\n  - { by: human:b, at: 2026-09-02T10:00:00Z }\n",
      );
    const theirs = base.replace("type: concept\n", "").replace("We charge $20.", "We charge $24.");
    const merge = mergeNotes({ base, mine, theirs, baseUnknown: true });
    expect(merge.text).toBeNull();
    expect(merge.conflicts.map((hunk) => [hunk.region, hunk.field ?? null, hunk.base])).toEqual([
      ["frontmatter", "verified", null],
      ["frontmatter", "type", null],
      ["frontmatter", "status", null],
      ["body", null, null],
    ]);
    // every side's text is there to choose from (fields in theirs' order, mine's extra ones after)
    expect(resolveMerge(merge, () => "theirs")).toBe(theirs);
    const mineChosen = resolveMerge(merge, () => "mine");
    for (const line of ["type: concept\n", "status: draft\n", "human:b", "We charge $20."]) {
      expect(mineChosen).toContain(line);
    }
    // what both sides agree on still merges
    expect(mergeNotes({ base: null, mine, theirs: mine, baseUnknown: true }).text).toBe(mine);
  });

  it("keeps CRLF line endings", () => {
    const crlf = base.replace(/\n/g, "\r\n");
    const mine = crlf.replace("We charge $20.", "We charge $24.");
    const merge = mergeNotes({ base: crlf, mine, theirs: crlf });
    expect(merge.text).toBe(mine);
  });
});

describe("restore", () => {
  it("marks the restored text as the person's change", () => {
    const restored = restoreText(base, "human:b", "2026-10-01T12:00:00Z");
    const provenance = readProvenance(parseNote(restored).frontmatter?.data ?? {});
    expect(provenance.generated).toMatchObject({ by: "human:b", at: "2026-10-01T12:00:00Z" });
    expect(provenance.verified.at(-1)).toMatchObject({ by: "human:b" });
    expect(parseNote(restored).body).toBe(parseNote(base).body);
  });

  it("adds no verified entry of the person's with verify false", () => {
    const restored = restoreText(base, "human:b", "2026-10-01T12:00:00Z", { verify: false });
    const provenance = readProvenance(parseNote(restored).frontmatter?.data ?? {});
    expect(provenance.generated).toMatchObject({ by: "human:b", at: "2026-10-01T12:00:00Z" });
    // the old version's own entries stay as they were
    expect(provenance.verified.map((entry) => entry.by)).toEqual(["human:a"]);
    expect(parseNote(restored).body).toBe(parseNote(base).body);
  });

  it("drops the old human entries, and keeps the agents', with stripHumanEntries", () => {
    const old = `---\ntitle: Pricing\ngenerated: { by: human:a, at: 2026-09-30T12:00:00Z }\nverified:\n  - { by: human:a, at: 2026-09-30T12:00:00Z }\n  - { by: claude-code/2.1, at: 2026-09-30T12:05:00Z }\n  - { by: " human:c ", at: 2026-09-30T12:06:00Z }\n---\nWe charge $2000.\n`;
    const restored = restoreText(old, "human:b", "2026-10-01T12:00:00Z", {
      verify: false,
      stripHumanEntries: true,
    });
    const provenance = readProvenance(parseNote(restored).frontmatter?.data ?? {});
    expect(provenance.generated).toMatchObject({ by: "human:b", at: "2026-10-01T12:00:00Z" });
    expect(provenance.verified.map((entry) => entry.by)).toEqual(["claude-code/2.1"]);
    expect(parseNote(restored).body).toBe(parseNote(old).body);
    // with verify, only the person's own new entry is a human one
    const verified = restoreText(old, "human:b", "2026-10-01T12:00:00Z", {
      stripHumanEntries: true,
    });
    expect(
      readProvenance(parseNote(verified).frontmatter?.data ?? {}).verified.map((entry) => entry.by),
    ).toEqual(["claude-code/2.1", "human:b"]);
  });
});
