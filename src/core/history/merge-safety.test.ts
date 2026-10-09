import { describe, expect, it } from "vitest";

import { parseNote } from "../note/index.js";
import { lineDiff } from "./diff.js";
import { mergeNotes, withConflictMarkers } from "./merge.js";

const note = (frontmatter: string, body: string) => `---\n${frontmatter}---\n${body}`;

/** A small seeded random generator (mulberry32), so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Side {
  fields: Map<string, string>;
  lines: string[];
  /** Tokens this side introduced (new values and lines). */
  tokens: string[];
}

function mutate(base: Side, side: string, next: () => number): Side {
  const fields = new Map(base.fields);
  const tokens: string[] = [];
  for (const key of base.fields.keys()) {
    const roll = next();
    if (roll < 0.25) {
      const value = `${side}-${key}-${String(Math.floor(next() * 1e6))}`;
      fields.set(key, value);
      tokens.push(value);
    } else if (roll < 0.35) fields.delete(key);
  }
  if (next() < 0.3) {
    const key = `${side}new`;
    const value = `${side}-added-${String(Math.floor(next() * 1e6))}`;
    fields.set(key, value);
    tokens.push(value);
  }
  const lines: string[] = [];
  for (const line of base.lines) {
    const roll = next();
    if (roll < 0.15) {
      const replaced = `${side}-line-${String(Math.floor(next() * 1e6))}`;
      lines.push(replaced);
      tokens.push(replaced);
    } else if (roll < 0.22) continue;
    else lines.push(line);
    if (next() < 0.08) {
      const inserted = `${side}-insert-${String(Math.floor(next() * 1e6))}`;
      lines.push(inserted);
      tokens.push(inserted);
    }
  }
  return { fields, lines, tokens };
}

function render(side: Pick<Side, "fields" | "lines">): string {
  const frontmatter = [...side.fields].map(([key, value]) => `${key}: ${value}\n`).join("");
  return note(frontmatter, side.lines.map((line) => `${line}\n`).join(""));
}

describe("merge safety", () => {
  it("never drops a change: every new field value and line is in the result or a conflict", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const base: Side = {
        fields: new Map(
          Array.from({ length: 5 }, (_, i) => [`f${String(i)}`, `base-${String(i)}`]),
        ),
        lines: Array.from({ length: 12 }, (_, i) => `base-line-${String(i)}`),
        tokens: [],
      };
      const mine = mutate(base, "mine", next);
      const theirs = mutate(base, "theirs", next);
      const merge = mergeNotes({ base: render(base), mine: render(mine), theirs: render(theirs) });
      const everything = withConflictMarkers(merge);
      for (const token of [...mine.tokens, ...theirs.tokens]) {
        expect(everything, `seed ${String(seed)}: ${token}`).toContain(token);
      }
      if (merge.text !== null)
        expect(parseNote(merge.text).problems, `seed ${String(seed)}`).toEqual([]);
    }
  });

  it("makes a field one side changed and the other removed a conflict", () => {
    const base = note("a: 1\nb: 2\n", "x\n");
    const edited = mergeNotes({
      base,
      mine: note("a: 1\nb: 3\n", "x\n"),
      theirs: note("a: 1\n", "x\n"),
    });
    expect(edited.conflicts).toMatchObject([
      { region: "frontmatter", field: "b", mine: "b: 3\n", theirs: null },
    ]);
    const removed = mergeNotes({
      base,
      mine: note("a: 1\n", "x\n"),
      theirs: note("a: 1\nb: 4\n", "x\n"),
    });
    expect(removed.conflicts).toMatchObject([{ field: "b", mine: null, theirs: "b: 4\n" }]);
  });

  it("makes fields that merge into invalid YAML one frontmatter conflict", () => {
    const merge = mergeNotes({
      base: note("x: &a 1\n", "body\n"),
      mine: note("x: &a 1\ny: *a\n", "body\n"),
      theirs: note("z: 2\n", "body\n"),
    });
    expect(merge.text).toBeNull();
    expect(merge.conflicts).toMatchObject([{ region: "frontmatter", mine: "x: &a 1\ny: *a\n" }]);
    expect(merge.conflicts[0]).not.toHaveProperty("field");
  });

  it("treats line-ending-only and final-newline-only differences as no change", () => {
    const base = "one\ntwo\nthree\n";
    const merge = mergeNotes({
      base,
      mine: "one\r\ntwo\r\nthree\r\n",
      theirs: "one\ntwo\nthree changed\n",
    });
    expect(merge.text).toBe("one\ntwo\nthree changed\n");
    const tail = mergeNotes({ base, mine: "one\ntwo\nthree", theirs: "ONE\ntwo\nthree\n" });
    expect(tail.text).toBe("ONE\ntwo\nthree\n");
  });
});

describe("merge and diff speed", () => {
  const lines = (count: number, tag: (i: number) => string) =>
    Array.from({ length: count }, (_, i) => `${tag(i)}\n`).join("");

  it("merges and diffs 20,000 lines with scattered edits in well under a second", () => {
    const base = lines(20_000, (i) => `line ${String(i)}`);
    const mine = lines(20_000, (i) => (i % 997 === 0 ? `mine ${String(i)}` : `line ${String(i)}`));
    const theirs = lines(20_000, (i) =>
      i % 1009 === 500 ? `theirs ${String(i)}` : `line ${String(i)}`,
    );
    const start = Date.now();
    const merge = mergeNotes({ base, mine, theirs });
    const diff = lineDiff(base, mine);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(merge.conflicts).toEqual([]);
    expect(merge.text).toContain("mine 997\n");
    expect(merge.text).toContain("theirs 1509\n");
    expect(diff.coarse).toBe(false);
  });

  it("gives up quickly on 20,000 lines rewritten on both sides", () => {
    const base = lines(20_000, (i) => `base ${String(i)}`);
    const mine = lines(20_000, (i) => `mine ${String(i)}`);
    const theirs = lines(20_000, (i) => `theirs ${String(i)}`);
    const start = Date.now();
    const merge = mergeNotes({ base, mine, theirs });
    const diff = lineDiff(base, mine);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(merge.conflicts).toHaveLength(1);
    expect(merge.conflicts[0]).toMatchObject({ region: "body", mine, theirs, base });
    expect(diff).toMatchObject({ coarse: true, added: 20_000, removed: 20_000 });
  });
});
