import { afterEach, describe, expect, it } from "vitest";

import { fixtureId, fixtureNotes, loadFixtureWorkspace } from "../../../test/fixture-workspace.js";
import {
  createSearchIndex,
  createWorkspace,
  removeNote,
  restoreSearchIndex,
  type SearchHit,
  upsertNote,
} from "../index.js";
import { resetWordSegmenter, tokenize } from "./terms.js";

const workspace = loadFixtureWorkspace();
const notes = () => workspace.notes.values();
const paths = (hits: readonly SearchHit[]) => hits.map((hit) => hit.path);
const highlighted = (text: string, ranges: readonly { start: number; end: number }[]) =>
  ranges.map((range) => text.slice(range.start, range.end));

describe("searching the fixture workspace", () => {
  const index = createSearchIndex(notes());

  it("indexes every note", () => {
    expect(index.size).toBe(workspace.notes.size);
    expect(index.has(fixtureId("research/pricing.md"))).toBe(true);
  });

  it("finds a note by its title, ranking title matches first", () => {
    const hits = index.search("pricing model");
    expect(hits[0]?.path).toBe("research/pricing.md");
    expect(hits[0]?.fields).toContain("title");
    expect(highlighted(hits[0]?.title ?? "", hits[0]?.titleHighlights ?? [])).toEqual([
      "Pricing",
      "model",
    ]);
  });

  it("finds a phrase in the body, with a snippet and highlight positions", () => {
    const hits = index.search("monthly churn fell");
    expect(paths(hits)).toEqual(["research/churn.md"]);
    const snippet = hits[0]?.snippet;
    expect(snippet?.field).toBe("body");
    expect(snippet?.text).toContain("Monthly churn fell to 2.4% in September.");
    expect(highlighted(snippet?.text ?? "", snippet?.highlights ?? []).slice(0, 4)).toEqual([
      "Churn",
      "Monthly",
      "churn",
      "fell",
    ]);
    expect(snippet?.truncatedStart).toBe(false);
  });

  it("finds a note by a custom frontmatter value", () => {
    const hits = index.search("growth");
    expect(paths(hits)).toEqual(["notes/custom-keys.md"]);
    expect(hits[0]?.fields).toEqual(["properties"]);
    expect(hits[0]?.snippet?.field).toBe("properties");
    expect(paths(index.search("third quarter"))).toEqual(["notes/custom-keys.md"]);
  });

  it("matches prefixes and typos", () => {
    expect(paths(index.search("compet"))[0]).toBe("research/competitors.md");
    expect(paths(index.search("competitrs"))[0]).toBe("research/competitors.md");
    expect(index.search("compet", { prefix: false })).toEqual([]);
    expect(index.search("competitrs", { fuzzy: false })).toEqual([]);
  });

  it("combines words with AND by default, OR on request", () => {
    expect(index.search("refunds annual-plans-nowhere")).toEqual([]);
    expect(paths(index.search("refunds zzzz", { combineWith: "or" }))).toEqual([
      "decisions/old-review.md",
    ]);
  });

  it("ignores accents and case", () => {
    const accented = createSearchIndex(
      createWorkspace([
        { id: "n1", path: "cafe.md", text: "# Résumé\n\nThe CAFÉ menu.\n" },
      ]).notes.values(),
    );
    expect(paths(accented.search("resume cafe"))).toEqual(["cafe.md"]);
  });

  it("never prefix-matches a single character", () => {
    expect(index.search("p")).toEqual([]);
    expect(paths(index.search("pr")).length).toBeGreaterThan(0);
  });

  it("filters by type, folder, tags and ids", () => {
    expect(paths(index.search("pricing", { filters: { types: ["metric"] } }))).toEqual([
      "research/churn.md",
    ]);
    expect(paths(index.search("pricing", { filters: { folder: "decisions" } }))).toEqual([
      "decisions/annual-plans.md",
    ]);
    expect(paths(index.search("pricing", { filters: { tags: ["Plans"] } }))).toEqual([
      "research/pricing.md",
    ]);
    const ids = new Set([fixtureId("research/competitors.md")]);
    expect(paths(index.search("pricing", { filters: { ids } }))).toEqual([
      "research/competitors.md",
    ]);
    expect(index.search("pricing", { filters: { folder: "research" } }).length).toBeGreaterThan(2);
  });

  it("limits results and returns nothing for an empty query", () => {
    expect(index.search("pricing", { limit: 2 })).toHaveLength(2);
    expect(index.search("")).toEqual([]);
    expect(index.search("  ?! ")).toEqual([]);
  });

  it("returns a snippet window with ellipsis flags for a long body", () => {
    const long = `${"filler words here. ".repeat(40)}The needle sits here. ${"more filler text. ".repeat(40)}`;
    const small = createSearchIndex(
      createWorkspace([{ id: "n1", path: "long.md", text: long }]).notes.values(),
    );
    const snippet = small.search("needle")[0]?.snippet;
    expect(snippet?.truncatedStart).toBe(true);
    expect(snippet?.truncatedEnd).toBe(true);
    expect(snippet?.text.length).toBeLessThanOrEqual(200);
    expect(highlighted(snippet?.text ?? "", snippet?.highlights ?? [])).toEqual(["needle"]);
  });
});

describe("languages written without spaces", () => {
  const cjk = createWorkspace([
    {
      id: "ja",
      path: "ja.md",
      text: "---\ntitle: 東京の会議\n---\n来週の会議は東京で行います。\n",
    },
    { id: "zh", path: "zh.md", text: "---\ntitle: 价格模型\n---\n我们的价格模型包括年度计划。\n" },
    { id: "en", path: "en.md", text: "# Pricing\n\nMeeting in Tokyo next week.\n" },
  ]);

  afterEach(() => {
    resetWordSegmenter();
  });

  it("splits Chinese and Japanese into words", () => {
    expect(tokenize("我们的价格模型").length).toBeGreaterThan(1);
    const index = createSearchIndex(cjk.notes.values());
    expect(paths(index.search("東京"))).toEqual(["ja.md"]);
    expect(paths(index.search("会議"))).toEqual(["ja.md"]);
    expect(paths(index.search("价格"))).toEqual(["zh.md"]);
    expect(paths(index.search("年度计划"))).toEqual(["zh.md"]);
    const hit = index.search("東京")[0];
    expect(hit?.titleHighlights.map((range) => hit.title.slice(range.start, range.end))).toEqual([
      "東京",
    ]);
  });

  it("falls back to one term per character without Intl.Segmenter", () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      resetWordSegmenter();
      expect(tokenize("价格 model")).toEqual(["价", "格", "model"]);
      const index = createSearchIndex(cjk.notes.values());
      expect(paths(index.search("价格"))).toEqual(["zh.md"]);
      expect(paths(index.search("東京"))).toEqual(["ja.md"]);
    } finally {
      Object.defineProperty(Intl, "Segmenter", { value: original, configurable: true });
    }
  });
});

describe("incremental updates", () => {
  it("re-indexes a changed note, and skips an unchanged one", () => {
    const index = createSearchIndex(notes());
    const pricing = workspace.notes.get(fixtureId("research/pricing.md"));
    if (pricing === undefined) throw new Error("fixture missing");
    expect(index.upsert(pricing)).toBe("unchanged");

    const next = upsertNote(workspace, {
      id: pricing.id,
      path: pricing.path,
      text: pricing.parsed.text.replace("billed up front", "billed fortnightly"),
    });
    const changed = next.notes.get(pricing.id);
    if (changed === undefined) throw new Error("note missing");
    expect(index.upsert(changed)).toBe("updated");
    expect(paths(index.search("fortnightly", { prefix: false, fuzzy: false }))).toEqual([
      "research/pricing.md",
    ]);
    expect(index.search("front", { prefix: false, fuzzy: false })).toEqual([]);
  });

  it("follows moves, adds and removals", () => {
    const index = createSearchIndex(notes());
    let next = upsertNote(workspace, {
      id: fixtureId("research/churn.md"),
      path: "metrics/churn.md",
      text: workspace.notes.get(fixtureId("research/churn.md"))?.parsed.text ?? "",
    });
    next = upsertNote(next, { id: "new", path: "ideas/zebra.md", text: "# Zebra pricing\n" });
    next = removeNote(next, fixtureId("research/competitors.md"));
    expect(index.sync(next.notes.values())).toEqual({
      added: 1,
      updated: 1,
      removed: 1,
      unchanged: workspace.notes.size - 2,
    });
    expect(paths(index.search("zebra"))).toEqual(["ideas/zebra.md"]);
    expect(paths(index.search("churn", { filters: { folder: "metrics" } }))).toEqual([
      "metrics/churn.md",
    ]);
    expect(paths(index.search("competitors"))).not.toContain("research/competitors.md");
    expect(index.remove("new")).toBe(true);
    expect(index.remove("new")).toBe(false);
    expect(index.search("zebra")).toEqual([]);
  });
});

describe("serializing", () => {
  const queries = ["pricing", "churn september", "growth", "compet", "refund"];

  it("restores to the same results", () => {
    const index = createSearchIndex(notes());
    const restored = restoreSearchIndex(index.serialize(), notes());
    expect(restored.rebuilt).toBe(false);
    expect(restored.changes).toEqual({
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: workspace.notes.size,
    });
    for (const query of queries) {
      expect(restored.index.search(query)).toEqual(index.search(query));
    }
  });

  it("brings a restored cache up to date with the current notes", () => {
    const cached = createSearchIndex(notes()).serialize();
    let next = removeNote(workspace, fixtureId("log.md"));
    next = upsertNote(next, { id: "new", path: "zebra.md", text: "# Zebra\n" });
    const pricing = next.notes.get(fixtureId("research/pricing.md"));
    next = upsertNote(next, {
      id: fixtureId("research/pricing.md"),
      path: "research/pricing.md",
      text: (pricing?.parsed.text ?? "").replace("up front", "monthly"),
    });
    const { index, changes } = restoreSearchIndex(cached, next.notes.values());
    expect(changes).toEqual({
      added: 1,
      updated: 1,
      removed: 1,
      unchanged: workspace.notes.size - 2,
    });
    // the same notes match; scores can differ slightly while discarded entries await vacuuming
    const fresh = createSearchIndex(next.notes.values());
    const sorted = (hits: readonly SearchHit[]) => paths(hits).sort();
    for (const query of [...queries, "zebra", "monthly", "activity"]) {
      expect(sorted(index.search(query))).toEqual(sorted(fresh.search(query)));
    }
  });

  it("rebuilds from the notes when the cache is unreadable or corrupt inside", () => {
    const good = JSON.parse(createSearchIndex(notes()).serialize()) as Record<string, unknown>;
    const engine = good["engine"] as Record<string, unknown>;
    const corrupt = [
      JSON.stringify({ ...good, version: 1 }),
      JSON.stringify({ ...good, engine: { ...engine, index: "nope" } }),
      JSON.stringify({ ...good, engine: { ...engine, documentIds: null, fieldLength: 7 } }),
    ];
    for (const bad of ["", "{", "null", JSON.stringify({ format: "other" }), ...corrupt]) {
      const restored = restoreSearchIndex(bad, notes());
      expect(restored.rebuilt).toBe(true);
      expect(restored.index.size).toBe(workspace.notes.size);
    }
  });

  it("holds no note text beyond the index terms and fingerprints", () => {
    const serialized = createSearchIndex(notes()).serialize();
    expect(serialized).not.toContain("Monthly churn fell");
    expect(JSON.parse(serialized)).toMatchObject({ format: "knowtarium-search-index", version: 2 });
  });
});

describe("in any runtime", () => {
  it("builds from plain inputs without the workspace helpers", () => {
    const index = createSearchIndex(createWorkspace(fixtureNotes()).notes.values());
    expect(index.search("pricing").length).toBeGreaterThan(0);
  });
});
