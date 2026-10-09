import { describe, expect, it, vi } from "vitest";

import { fixtureNotes } from "../../../test/fixture-workspace.js";
import { parseNote, serializeNote } from "./index.js";

describe("parseNote", () => {
  it("splits frontmatter and body", () => {
    const note = parseNote("---\ntitle: A\n---\n# A\n\nText\n");
    expect(note.frontmatter?.source).toBe("title: A\n");
    expect(note.frontmatter?.data).toEqual({ title: "A" });
    expect(note.frontmatter?.line).toBe(2);
    expect(note.body).toBe("# A\n\nText\n");
    expect(note.bodyLine).toBe(4);
    expect(note.problems).toEqual([]);
  });

  it("reads a note without frontmatter as all body", () => {
    const note = parseNote("# Just text\n");
    expect(note.frontmatter).toBeNull();
    expect(note.body).toBe("# Just text\n");
    expect(note.bodyLine).toBe(1);
    expect(note.problems).toEqual([]);
  });

  it("keeps a byte order mark and CRLF line endings", () => {
    const text = "﻿---\r\ntitle: A\r\n---\r\nBody\r\n";
    const note = parseNote(text);
    expect(note.eol).toBe("\r\n");
    expect(note.frontmatter?.data).toEqual({ title: "A" });
    expect(note.body).toBe("Body\r\n");
    expect(serializeNote(note)).toBe(text);
  });

  it("accepts empty frontmatter, `...` as the closing fence and a missing final newline", () => {
    expect(parseNote("---\n---\nBody").frontmatter?.data).toEqual({});
    expect(parseNote("---\na: 1\n...\nBody").body).toBe("Body");
    const noBody = parseNote("---\na: 1\n---");
    expect(noBody.frontmatter?.data).toEqual({ a: 1 });
    expect(noBody.body).toBe("");
  });

  it("reports unclosed frontmatter and keeps the text as body", () => {
    const note = parseNote("---\ntitle: A\n\nNo closing fence\n");
    expect(note.frontmatter).toBeNull();
    expect(note.body).toBe("---\ntitle: A\n\nNo closing fence\n");
    expect(note.problems.map((problem) => problem.code)).toEqual(["frontmatter-unclosed"]);
  });

  it("reports invalid YAML with its line in the note, without throwing", () => {
    const note = parseNote("---\ntitle: A\ntags: [a, b\n---\nBody\n");
    expect(note.problems[0]).toMatchObject({ code: "frontmatter-yaml", line: 3 });
    expect(note.frontmatter?.data).toEqual({});
    expect(note.body).toBe("Body\n");
  });

  it("keeps a note with a duplicate key readable, reporting the duplicate", () => {
    const note = parseNote("---\ntitle: A\ntags: [x]\ntitle: B\n---\nBody\n");
    expect(note.problems).toHaveLength(1);
    expect(note.problems[0]).toMatchObject({ code: "frontmatter-yaml", line: 4 });
    expect(note.frontmatter?.data).toEqual({ title: "B", tags: ["x"] });
  });

  it("hands out frozen values and no mutable document", () => {
    const note = parseNote("---\nowner: { name: Sara }\ntags: [a]\n---\n");
    expect(Object.isFrozen(note)).toBe(true);
    expect(Object.isFrozen(note.frontmatter?.data["owner"])).toBe(true);
    expect(Object.isFrozen(note.frontmatter?.data["tags"])).toBe(true);
    expect(note.frontmatter).not.toHaveProperty("document");
  });

  it("reports frontmatter that is not a mapping", () => {
    const note = parseNote("---\n- a\n- b\n---\n");
    expect(note.problems.map((problem) => problem.code)).toEqual(["frontmatter-not-a-map"]);
  });

  it("serializes every fixture note byte for byte", () => {
    for (const { text } of fixtureNotes()) expect(serializeNote(parseNote(text))).toBe(text);
  });
});

describe("frontmatter keys that are collections", () => {
  it("reads a template's {{date}} key without writing to the console", () => {
    // core is typed without Node or DOM globals; the test runs under both
    const host = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
      process: { emitWarning: (...args: unknown[]) => void };
    };
    const warn = vi.spyOn(host.console, "warn").mockImplementation(() => undefined);
    const emit = vi.spyOn(host.process, "emitWarning").mockImplementation(() => undefined);
    try {
      const note = parseNote("---\n{{date}}: today\ntitle: Daily\n---\nBody.\n");
      expect(note.frontmatter?.data["title"]).toBe("Daily");
      expect(Object.keys(note.frontmatter?.data ?? {})).toHaveLength(2);
      expect(note.problems).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      emit.mockRestore();
    }
  });
});
