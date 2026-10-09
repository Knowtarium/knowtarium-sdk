import { describe, expect, it } from "vitest";

import { fixtureText } from "../../../test/fixture-workspace.js";
import { lineChange } from "../../../test/line-diff.js";
import { parseNote } from "../note/index.js";
import { FrontmatterEditError, setGenerated } from "./index.js";

const AT = "2026-09-30T12:00:00Z";

function generate(text: string): string {
  return setGenerated(parseNote(text), "human:maya", AT).text;
}

describe("setGenerated", () => {
  it("changes only the by and at values of a block mapping, keeping its comment", () => {
    const before = fixtureText("notes/custom-keys.md");
    const after = generate(before);
    expect(lineChange(before, after)).toEqual({
      removed: ["  by: agent:importer   # set by the import", "  at: 2026-09-22T08:00:00Z"],
      added: ["  by: human:maya   # set by the import", "  at: 2026-09-30T12:00:00Z"],
    });
  });

  it("changes only the values inside a flow mapping", () => {
    const before = fixtureText("research/churn.md");
    expect(lineChange(before, generate(before))).toEqual({
      removed: ["generated: { by: claude-code/2.1, at: 2026-09-26T08:10:00Z }"],
      added: ["generated: { by: human:maya, at: 2026-09-30T12:00:00Z }"],
    });
  });

  it("keeps quoting and extra keys inside generated", () => {
    expect(
      generate("---\ngenerated: {by: \"agent:x\", at: '2026-01-01 10:00:00', model: small}\n---\n"),
    ).toBe("---\ngenerated: {by: \"human:maya\", at: '2026-09-30T12:00:00Z', model: small}\n---\n");
  });

  it("adds a missing by or at inside an existing mapping", () => {
    expect(generate("---\ngenerated:\n  by: agent:x # who\n---\n")).toBe(
      "---\ngenerated:\n  by: human:maya # who\n  at: 2026-09-30T12:00:00Z\n---\n",
    );
    expect(generate("---\ngenerated: { at: 2026-01-01 }\n---\n")).toBe(
      "---\ngenerated: { at: 2026-09-30T12:00:00Z, by: human:maya }\n---\n",
    );
  });

  it("adds generated at the end, or replaces a value of the wrong shape", () => {
    expect(generate("---\ntitle: A # the title\n---\nBody\n")).toBe(
      "---\ntitle: A # the title\ngenerated: { by: human:maya, at: 2026-09-30T12:00:00Z }\n---\nBody\n",
    );
    expect(generate("---\ngenerated: yesterday\ntitle: A\n---\n")).toBe(
      "---\ngenerated: { by: human:maya, at: 2026-09-30T12:00:00Z }\ntitle: A\n---\n",
    );
    expect(generate("---\ngenerated:\n  - a\n  - b\ntitle: A\n---\n")).toBe(
      "---\ngenerated: { by: human:maya, at: 2026-09-30T12:00:00Z }\ntitle: A\n---\n",
    );
  });

  it("refuses an invalid actor or time", () => {
    const note = parseNote("---\n---\n");
    expect(() => setGenerated(note, "human:", AT)).toThrow(FrontmatterEditError);
    expect(() => setGenerated(note, "human:maya", "2026-09-30")).toThrow(FrontmatterEditError);
    expect(() => setGenerated(note, "human:maya", new Date(Number.NaN))).toThrow(
      FrontmatterEditError,
    );
  });
});
