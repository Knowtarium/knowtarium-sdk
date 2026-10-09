import { describe, expect, it } from "vitest";

import { createLinkIndex, parseLinks, resolveLink } from "./index.js";

describe("parseLinks", () => {
  it("finds wikilinks with fragments, aliases and embeds", () => {
    const links = parseLinks("See [[Note#Heading|the note]] and ![[chart.png]].\n[[a\\|b]]", 5);
    expect(links).toEqual([
      {
        kind: "wikilink",
        embed: false,
        raw: "[[Note#Heading|the note]]",
        target: "Note",
        fragment: "Heading",
        label: "the note",
        line: 5,
        column: 5,
      },
      expect.objectContaining({ embed: true, target: "chart.png", line: 5, column: 35 }),
      expect.objectContaining({ target: "a", label: "b", line: 6 }),
    ]);
  });

  it("finds internal markdown links and skips external ones", () => {
    const body = [
      '[a](other.md#part) [b](<with space.md>) [c](my%20note.md "title")',
      "[web](https://example.com) [mail](mailto:a@b.c) [top](#top) [x](//cdn/x.png)",
      "![img](../img/a.png) [nested [brackets]](n.md) [paren](a_(b).md)",
    ].join("\n");
    expect(
      parseLinks(body).map((link) => [link.target, link.fragment, link.label, link.embed]),
    ).toEqual([
      ["other.md", "part", "a", false],
      ["with space.md", null, "b", false],
      ["my note.md", null, "c", false],
      ["../img/a.png", null, "img", true],
      ["n.md", null, "nested [brackets]", false],
      ["a_(b).md", null, "paren", false],
    ]);
  });

  it("ignores links in code", () => {
    const body =
      "`[[no]]` ``[[no `x` ]]`` [[yes]]\n```\n[[no]]\n```\n~~~~\n[b](no.md)\n~~~~\n[[yes2]]";
    expect(parseLinks(body).map((link) => [link.target, link.line])).toEqual([
      ["yes", 1],
      ["yes2", 8],
    ]);
  });
});

describe("parseLinks edge cases", () => {
  const targets = (body: string) => parseLinks(body).map((link) => link.target);

  it("skips escaped brackets", () => {
    expect(targets("\\[[no]] \\![[no]] \\[no](no.md) \\\\[[yes]]")).toEqual(["yes"]);
  });

  it("skips HTML comments, even across lines", () => {
    expect(targets("<!-- [[no]] --> [[yes]] <!-- start\n[[no]]\nend --> [b](yes2.md)")).toEqual([
      "yes",
      "yes2.md",
    ]);
  });

  it("skips indented code, but not indented list continuations", () => {
    const body = [
      "Text",
      "",
      "    [[code]]",
      "",
      "    [[still code]]",
      "[[after]]",
      "- item",
      "",
      "    [[continuation]]",
    ].join("\n");
    expect(targets(body)).toEqual(["after", "continuation"]);
    expect(targets("Paragraph\n    [[lazy continuation]]")).toEqual(["lazy continuation"]);
  });

  it("closes a fence only with a matching fence without an info string", () => {
    const body = ["```md", "[[no]]", "```js", "[[no]]", "``", "[[no]]", "````", "[[yes]]"].join(
      "\n",
    );
    expect(targets(body)).toEqual(["yes"]);
  });

  it("reads [[a]](b.md) as one wikilink, as Obsidian does", () => {
    const links = parseLinks("[[a]](b.md)");
    expect(links.map((link) => [link.kind, link.target, link.raw])).toEqual([
      ["wikilink", "a", "[[a]]"],
    ]);
  });
});

describe("resolveLink", () => {
  const index = createLinkIndex([
    { id: "1", path: "research/pricing.md", title: "Pricing model" },
    { id: "2", path: "archive/pricing.md", title: "Old pricing" },
    { id: "3", path: "research/q3/churn.md", title: "Churn" },
    { id: "4", path: "index.md", title: "Home" },
  ]);
  const resolve = (target: string, kind: "wikilink" | "markdown", from: string) =>
    resolveLink(
      index,
      { kind, embed: false, raw: "", target, fragment: null, label: null, line: 1, column: 1 },
      from,
    );

  it("resolves wikilinks by name, preferring the linking note's folder", () => {
    expect(resolve("pricing", "wikilink", "archive/x.md")).toEqual({ status: "note", noteId: "2" });
    expect(resolve("Pricing", "wikilink", "research/x.md")).toEqual({
      status: "note",
      noteId: "1",
    });
    expect(resolve("pricing", "wikilink", "other/x.md")).toMatchObject({ noteId: "2" });
  });

  it("resolves wikilinks by path, partial path and title", () => {
    expect(resolve("research/q3/churn", "wikilink", "index.md")).toMatchObject({ noteId: "3" });
    expect(resolve("q3/churn.md", "wikilink", "index.md")).toMatchObject({ noteId: "3" });
    expect(resolve("pricing model", "wikilink", "index.md")).toMatchObject({ noteId: "1" });
    expect(resolve("Nothing here", "wikilink", "index.md")).toEqual({ status: "ghost" });
    expect(resolve("diagram.png", "wikilink", "research/x.md")).toEqual({
      status: "asset",
      path: "research/diagram.png",
    });
    expect(resolve("../../up.png", "wikilink", "research/x.md")).toEqual({ status: "ghost" });
  });

  it("resolves markdown links as relative or rooted paths", () => {
    expect(resolve("q3/churn.md", "markdown", "research/x.md")).toMatchObject({ noteId: "3" });
    expect(resolve("../index", "markdown", "research/x.md")).toMatchObject({ noteId: "4" });
    expect(resolve("/research/pricing.md", "markdown", "archive/x.md")).toMatchObject({
      noteId: "1",
    });
    expect(resolve("research/pricing.md", "markdown", "archive/x.md")).toMatchObject({
      noteId: "1",
    });
    expect(resolve("../../up.md", "markdown", "research/x.md")).toEqual({ status: "ghost" });
    expect(resolve("/refs/a.csv", "markdown", "research/x.md")).toEqual({
      status: "asset",
      path: "refs/a.csv",
    });
  });
});
