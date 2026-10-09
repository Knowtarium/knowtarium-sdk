import { describe, expect, it } from "vitest";

import { fixtureNotes, fixtureText } from "../../../test/fixture-workspace.js";
import { lineChange } from "../../../test/line-diff.js";
import { parseNote } from "../note/index.js";
import { addVerified, FrontmatterEditError } from "./index.js";

const AT = "2026-09-30T12:00:00Z";

function verify(text: string): string {
  return addVerified(parseNote(text), "human:maya", AT).text;
}

describe("addVerified", () => {
  it("appends a flow entry after a trailing comment, changing nothing else", () => {
    const before = fixtureText("research/pricing.md");
    const after = verify(before);
    expect(lineChange(before, after)).toEqual({
      removed: [],
      added: ["  - { by: human:maya, at: 2026-09-30T12:00:00Z }"],
    });
  });

  it("appends a block entry to a list of block entries", () => {
    const before = fixtureText("research/competitors.md");
    expect(lineChange(before, verify(before))).toEqual({
      removed: [],
      added: ["  - by: human:maya", "    at: 2026-09-30T12:00:00Z"],
    });
  });

  it("leaves comments, custom keys, odd quoting and three date formats alone", () => {
    const before = fixtureText("notes/custom-keys.md");
    const after = verify(before);
    expect(lineChange(before, after)).toEqual({
      removed: [],
      added: ["verified:", "  - { by: human:maya, at: 2026-09-30T12:00:00Z }"],
    });
    expect(after).toContain("reviewed_on: 2026-09-21\n");
    expect(after).toContain("meeting_time: '2026-09-21T11:30:00+02:00'\n");
    expect(after).toContain("exported_at: 2026-09-21 18:45:00\n");
  });

  it("adds only one entry on every fixture note with a clean frontmatter", () => {
    for (const { path, text } of fixtureNotes()) {
      if (path === "notes/broken-yaml.md") continue;
      const after = verify(text);
      expect(lineChange(text, after).removed, path).toEqual([]);
      const verified = parseNote(after).frontmatter?.data["verified"];
      expect(Array.isArray(verified) && verified.at(-1), path).toEqual({
        by: "human:maya",
        at: AT,
      });
    }
  });

  it("matches the list's indentation and the entries' spacing", () => {
    const before = "---\nverified:\n    -   {by: a/1, at: 2026-01-01T00:00:00Z}\n---\n";
    expect(verify(before)).toBe(
      "---\nverified:\n    -   {by: a/1, at: 2026-01-01T00:00:00Z}\n    -   {by: human:maya, at: 2026-09-30T12:00:00Z}\n---\n",
    );
  });

  it("appends to a flow list", () => {
    expect(verify("---\nverified: [{ by: a/1, at: 2026-01-01 }] # c\n---\n")).toBe(
      "---\nverified: [{ by: a/1, at: 2026-01-01 }, { by: human:maya, at: 2026-09-30T12:00:00Z }] # c\n---\n",
    );
    expect(verify("---\nverified: []\n---\n")).toBe(
      "---\nverified: [{ by: human:maya, at: 2026-09-30T12:00:00Z }]\n---\n",
    );
  });

  it("creates the list when it is missing or empty", () => {
    expect(verify("---\ntitle: A\n---\nBody\n")).toBe(
      "---\ntitle: A\nverified:\n  - { by: human:maya, at: 2026-09-30T12:00:00Z }\n---\nBody\n",
    );
    expect(verify("---\nverified:\ntitle: A\n---\n")).toBe(
      "---\nverified:\n  - { by: human:maya, at: 2026-09-30T12:00:00Z }\ntitle: A\n---\n",
    );
    expect(verify("---\nverified: ~ # none yet\n---\n")).toBe(
      "---\nverified:\n  - { by: human:maya, at: 2026-09-30T12:00:00Z } # none yet\n---\n",
    );
  });

  it("adds frontmatter to a note without any", () => {
    expect(verify("# Title\n")).toBe(
      "---\nverified:\n  - { by: human:maya, at: 2026-09-30T12:00:00Z }\n---\n# Title\n",
    );
  });

  it("keeps CRLF line endings", () => {
    const before =
      "---\r\nverified:\r\n  - { by: a/1, at: 2026-01-01T00:00:00Z }\r\n---\r\nBody\r\n";
    expect(verify(before)).toBe(
      "---\r\nverified:\r\n  - { by: a/1, at: 2026-01-01T00:00:00Z }\r\n  - { by: human:maya, at: 2026-09-30T12:00:00Z }\r\n---\r\nBody\r\n",
    );
  });

  it("accepts agent actors in both forms and a Date", () => {
    const note = parseNote("---\nverified: []\n---\n");
    const at = new Date(Date.UTC(2026, 8, 30, 12));
    expect(addVerified(note, "agent:checker", at).text).toContain(
      "{ by: agent:checker, at: 2026-09-30T12:00:00Z }",
    );
    expect(addVerified(note, "claude-code/2.1", at).text).toContain("by: claude-code/2.1");
  });

  it("refuses bad input and frontmatter it can't extend", () => {
    const note = parseNote("---\nverified: []\n---\n");
    expect(() => addVerified(note, "maya" as "human:maya", AT)).toThrow(FrontmatterEditError);
    expect(() => addVerified(note, "human:maya", "yesterday")).toThrow(FrontmatterEditError);
    expect(() => addVerified(parseNote("---\nverified: yes\n---\n"), "human:maya", AT)).toThrow(
      FrontmatterEditError,
    );
    expect(() => verify(fixtureText("notes/broken-yaml.md"))).toThrow(FrontmatterEditError);
    expect(() => verify("---\ntitle: A\nno closing fence\n")).toThrow(FrontmatterEditError);
  });
});
