import { describe, expect, it } from "vitest";

import { fixtureText } from "../../../test/fixture-workspace.js";
import { lineChange } from "../../../test/line-diff.js";
import { parseNote } from "../note/index.js";
import {
  FrontmatterEditError,
  removeField,
  setBody,
  setDescription,
  setField,
  setGenerated,
  setStaleAfter,
  setStatus,
  setTags,
  setTitle,
  setType,
} from "./index.js";

const custom = () => parseNote(fixtureText("notes/custom-keys.md"));

describe("field edits", () => {
  it("keeps single quotes when setting a single-quoted title", () => {
    const before = custom();
    const after = setTitle(before, "Q4 review: it's on");
    expect(lineChange(before.text, after.text)).toEqual({
      removed: ["title: 'Q3 review: what''s next'"],
      added: ["title: 'Q4 review: it''s on'"],
    });
  });

  it("keeps double quotes when setting a double-quoted description", () => {
    const before = custom();
    const after = setDescription(before, 'Say "hi"');
    expect(lineChange(before.text, after.text)).toEqual({
      removed: ['description: "Quarterly review, with \\"quotes\\" and a colon: kept as written"'],
      added: ['description: "Say \\"hi\\""'],
    });
  });

  it("keeps the comment after a plain value and quotes only when needed", () => {
    const before = custom();
    expect(lineChange(before.text, setType(before, "Workshop").text)).toEqual({
      removed: ["type: Meeting   # an unknown type is fine"],
      added: ["type: Workshop   # an unknown type is fine"],
    });
    expect(setStatus(parseNote("---\nstatus: a\n---\n"), "true").text).toBe(
      '---\nstatus: "true"\n---\n',
    );
    expect(setTitle(parseNote("---\ntitle: a\n---\n"), "a: b #c").text).toBe(
      '---\ntitle: "a: b #c"\n---\n',
    );
  });

  it("replaces a block scalar and an empty value", () => {
    expect(setTitle(parseNote("---\ntitle: |\n  one\n  two\nx: 1\n---\n"), "One").text).toBe(
      "---\ntitle: One\nx: 1\n---\n",
    );
    expect(setTitle(parseNote("---\ntitle:\nx: 1\n---\n"), "One").text).toBe(
      "---\ntitle: One\nx: 1\n---\n",
    );
  });

  it("writes numbers and booleans as YAML scalars", () => {
    const before = custom();
    const after = setField(setField(before, "priority", 3), "draft", true);
    expect(lineChange(before.text, after.text)).toEqual({
      removed: ["priority: 2", "draft: false"],
      added: ["priority: 3", "draft: true"],
    });
  });

  it("sets and removes stale_after, keeping the date-only style out of other keys", () => {
    const before = custom();
    const later = setStaleAfter(before, "2027-06-30T00:00:00Z");
    expect(lineChange(before.text, later.text)).toEqual({
      removed: ["stale_after: 2027-01-31"],
      added: ["stale_after: 2027-06-30T00:00:00Z"],
    });
    const removed = setStaleAfter(before, null);
    expect(lineChange(before.text, removed.text)).toEqual({
      removed: ["stale_after: 2027-01-31"],
      added: [],
    });
    expect(removeField(before, "missing")).toBe(before);
  });

  it("removes a block value with all its lines", () => {
    expect(removeField(parseNote("---\na: 1\ntags:\n  - x\n  - y\nb: 2\n---\n"), "tags").text).toBe(
      "---\na: 1\nb: 2\n---\n",
    );
  });

  it("sets tags in the list's own style", () => {
    const before = fixtureText("research/pricing.md");
    expect(lineChange(before, setTags(parseNote(before), ["pricing", "q3"]).text)).toEqual({
      removed: ["tags: [pricing, plans]"],
      added: ["tags: [pricing, q3]"],
    });
    const block = fixtureText("research/competitors.md");
    expect(lineChange(block, setTags(parseNote(block), ["market", "b2b"]).text)).toEqual({
      removed: [],
      added: ["  - b2b"],
    });
    expect(setTags(parseNote("---\ntitle: A\n---\n"), ["a", "b, c"]).text).toBe(
      "---\ntitle: A\ntags:\n  - a\n  - b, c\n---\n",
    );
    expect(setTags(parseNote("---\ntags: one\n---\n"), ["one", "two"]).text).toBe(
      "---\ntags:\n  - one\n  - two\n---\n",
    );
    expect(setTags(parseNote("---\ntags:\n  - a\n---\n"), []).text).toBe("---\ntags: []\n---\n");
  });

  it("edits a block list item by item, keeping unchanged lines and their comments", () => {
    const before = [
      "---",
      "tags:",
      "    # the product area",
      "    - 'pricing'   # quoted on purpose",
      "    - plans",
      "    # about the market",
      "    - market # keep me",
      "title: A",
      "---",
      "",
    ].join("\n");
    const after = setTags(parseNote(before), ["new", "pricing", "market", "last"]).text;
    expect(after).toBe(
      [
        "---",
        "tags:",
        "    - new",
        "    # the product area",
        "    - 'pricing'   # quoted on purpose",
        "    # about the market",
        "    - market # keep me",
        "    - last",
        "title: A",
        "---",
        "",
      ].join("\n"),
    );
  });

  it("edits a flow list item by item, keeping the text of unchanged items", () => {
    expect(
      setTags(parseNote("---\ntags: [ 'a', \"b\", c ] # t\n---\n"), ["a", "c", "d"]).text,
    ).toBe("---\ntags: [ 'a', c, d ] # t\n---\n");
  });

  it("refuses an edit that would change another field through an alias", () => {
    const note = parseNote(
      "---\ngenerated: &g { by: agent:x, at: 2026-01-01T00:00:00Z }\ncopy: *g\n---\n",
    );
    expect(() => setGenerated(note, "human:maya", "2026-09-30T12:00:00Z")).toThrow(
      FrontmatterEditError,
    );
    const merged = parseNote("---\nbase: &b { status: draft }\nnote:\n  <<: *b\n---\n");
    expect(setStatus(merged, "done").frontmatter?.data["base"]).toEqual({ status: "draft" });
  });
});

describe("setBody", () => {
  it("changes only the body", () => {
    const before = custom();
    const after = setBody(before, "# Q3 review\n\nRewritten.\n");
    expect(after.text.slice(0, after.bodyOffset)).toBe(before.text.slice(0, before.bodyOffset));
    expect(after.body).toBe("# Q3 review\n\nRewritten.\n");
    expect(after.frontmatter?.data).toEqual(before.frontmatter?.data);
  });

  it("works on notes without frontmatter and keeps a byte order mark", () => {
    expect(setBody(parseNote("\uFEFFold\n"), "new\n").text).toBe("\uFEFFnew\n");
  });

  it("puts a line break after a closing fence at the very end", () => {
    expect(setBody(parseNote("---\na: 1\n---"), "hi").text).toBe("---\na: 1\n---\nhi");
    expect(setBody(parseNote("---\r\na: 1\r\n---"), "hi").text).toBe("---\r\na: 1\r\n---\r\nhi");
    expect(setBody(parseNote("---\na: 1\n---"), "").text).toBe("---\na: 1\n---");
  });

  it("never turns a body into frontmatter", () => {
    const body = "---\ntitle: Not frontmatter\n---\nText\n";
    const after = setBody(parseNote("Old text\n"), body);
    expect(after.body).toBe(body);
    expect(after.text).toBe(`---\n---\n${body}`);
    expect(after.frontmatter?.data).toEqual({});
    const withFrontmatter = setBody(parseNote("---\na: 1\n---\nOld\n"), body);
    expect(withFrontmatter.body).toBe(body);
    expect(withFrontmatter.frontmatter?.data).toEqual({ a: 1 });
  });
});
