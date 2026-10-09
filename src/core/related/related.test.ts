import { describe, expect, it } from "vitest";

import { fixtureId, fixtureText, loadFixtureWorkspace } from "../../../test/fixture-workspace.js";
import { changedValues, relatedNotes, upsertNote } from "../index.js";

const id = fixtureId;
const workspace = loadFixtureWorkspace();

// a note that repeats churn's number, two hops away: churn <- competitors -> board update
const BOARD_UPDATE = `---
title: Board update
description: What we told the board in September
---

Churn is at 2.4% a month, the lowest this year.
`;
const planted = upsertNote(
  upsertNote(workspace, { id: "note:board", path: "notes/board-update.md", text: BOARD_UPDATE }),
  {
    id: id("research/competitors.md"),
    path: "research/competitors.md",
    text: `${fixtureText("research/competitors.md")}\nSee also the [[Board update]].\n`,
  },
);

describe("relatedNotes", () => {
  it("ranks linked notes first, with titles, descriptions and reasons", () => {
    const related = relatedNotes(workspace, id("research/pricing.md"));
    expect(related[0]).toMatchObject({
      path: "research/churn.md",
      title: "Churn",
      description: null,
    });
    const kinds = (path: string) =>
      related.find((note) => note.path === path)?.reasons.map((reason) => reason.kind);
    expect(kinds("research/churn.md")).toEqual([
      "links-to",
      "linked-from",
      "listed-in-folder-index",
    ]);
    expect(kinds("decisions/annual-plans.md")).toEqual(["links-to", "linked-from"]);
    expect(kinds("research/competitors.md")).toEqual([
      "linked-from",
      "listed-in-folder-index",
      "co-cited",
    ]);
    expect(related.map((note) => note.path)).not.toContain("research/pricing.md");
  });

  it("leaves out index and log notes unless asked", () => {
    const paths = relatedNotes(workspace, id("research/pricing.md")).map((note) => note.path);
    expect(paths.some((path) => path.endsWith("index.md") || path.endsWith("log.md"))).toBe(false);
    const all = relatedNotes(workspace, id("research/pricing.md"), {
      includeReserved: true,
      limit: 20,
    });
    expect(all.map((note) => note.path)).toContain("research/index.md");
  });

  it("scores shared tags and sources, weaker the more notes share them", () => {
    const tagged = upsertNote(
      upsertNote(workspace, {
        id: "a",
        path: "a.md",
        text: "---\ntags: [plans]\nsources:\n  - resource: /references/billing-2026-09.csv\n---\nA\n",
      }),
      { id: "b", path: "b.md", text: "---\ntags: [plans, pricing]\n---\nB\n" },
    );
    const related = relatedNotes(tagged, id("research/pricing.md"), { limit: 20 });
    const reasons = (noteId: string) => related.find((note) => note.id === noteId)?.reasons ?? [];
    expect(reasons("b").map((reason) => [reason.kind, reason.detail])).toEqual([
      ["shared-tag", "pricing"],
      ["shared-tag", "plans"],
    ]);
    // "pricing" is shared by one other note, "plans" by two
    expect(reasons("b")[0]?.weight).toBeGreaterThan(reasons("b")[1]?.weight ?? Infinity);

    const fromChurn = relatedNotes(tagged, id("research/churn.md"), { limit: 20 });
    expect(fromChurn.find((note) => note.id === "a")?.reasons).toEqual([
      { kind: "shared-source", weight: 2.5, detail: "/references/billing-2026-09.csv" },
    ]);
  });

  it("finds a note two hops away that still states a value the change replaced", () => {
    const before = fixtureText("research/churn.md");
    const after = before.replace("fell to 2.4%", "rose to 3.1%");
    const related = relatedNotes(planted, id("research/churn.md"), { change: { before, after } });
    // the directly linked notes still come first; the contradiction is among the top results
    const board = related.slice(0, 3).find((note) => note.path === "notes/board-update.md");
    expect(board).toMatchObject({
      title: "Board update",
      description: "What we told the board in September",
    });
    expect(board?.reasons).toEqual([{ kind: "mentions-changed-value", weight: 4, detail: "2.4%" }]);
    // without the change it isn't related at all
    const plain = relatedNotes(planted, id("research/churn.md"));
    expect(plain.map((note) => note.path)).not.toContain("notes/board-update.md");
  });

  it("follows one hop further from the top results on request", () => {
    const related = relatedNotes(planted, id("research/churn.md"), { oneHop: true, limit: 10 });
    const board = related.find((note) => note.path === "notes/board-update.md");
    expect(board?.reasons).toEqual([
      expect.objectContaining({ kind: "one-hop", detail: "Competitors" }),
    ]);
    const direct = related.find((note) => note.path === "research/competitors.md");
    expect(direct?.score).toBeGreaterThan(board?.score ?? Infinity);
  });

  it("caps the list and returns nothing for an unknown note", () => {
    expect(relatedNotes(workspace, id("research/pricing.md"), { limit: 1 })).toHaveLength(1);
    expect(relatedNotes(workspace, "missing")).toEqual([]);
  });
});

describe("changedValues", () => {
  it("lists the numbers, dates and names the change removed or replaced", () => {
    const before =
      "Churn fell to 2.4% on 2026-09-26, per Acme Cloud and Stripe. Revenue is $1,200. Item 3.";
    const after = "Churn rose to 3.1% on 2026-09-26, per Acme Cloud. Revenue is $1,300. Item 4.";
    expect(
      changedValues(before, after).map((value) => [value.kind, value.text, value.needle]),
    ).toEqual([
      ["number", "2.4%", "2.4"],
      ["number", "$1,200", "1,200"],
      ["name", "Stripe", "Stripe"],
    ]);
  });

  it("reads bodies only, so frontmatter dates don't count", () => {
    const before = fixtureText("research/churn.md");
    const after = before.replace("2026-09-26T08:10:00Z", "2026-09-30T08:10:00Z");
    const related = relatedNotes(workspace, id("research/churn.md"), { change: { before, after } });
    expect(related.flatMap((note) => note.reasons).map((reason) => reason.kind)).not.toContain(
      "mentions-changed-value",
    );
  });
});
