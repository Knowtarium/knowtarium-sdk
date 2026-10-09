import { describe, expect, it } from "vitest";

import {
  FIXTURE_VERIFICATION_STATES,
  fixtureId,
  loadFixtureWorkspace,
} from "../../../test/fixture-workspace.js";
import {
  buildGraphData,
  createWorkspace,
  graphEdgeKey,
  type VerificationSignals,
} from "../index.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const workspace = loadFixtureWorkspace();
const id = fixtureId;
const TRUST = (): VerificationSignals => ({ humanEntries: "trust-frontmatter" });

describe("buildGraphData", () => {
  const data = buildGraphData(workspace, { now: NOW, signals: TRUST });
  const node = (path: string) => data.nodes.find((entry) => entry.key === id(path))?.attributes;

  it("has one node per note, sorted by path, in graphology's format", () => {
    expect(data.options).toEqual({ type: "directed", multi: false, allowSelfLoops: true });
    expect(data.nodes.map((entry) => entry.attributes.path)).toEqual(
      [...workspace.notes.values()].map((note) => note.path).sort((a, b) => a.localeCompare(b)),
    );
    expect(data.nodes.every((entry) => !entry.attributes.ghost)).toBe(true);
  });

  it("puts each note's tier, state and freshness on its node", () => {
    for (const [path, state] of Object.entries(FIXTURE_VERIFICATION_STATES)) {
      expect(node(path)?.state).toBe(state);
    }
    expect(node("research/pricing.md")).toMatchObject({
      label: "Pricing model",
      type: "Concept",
      role: "note",
      tier: "human-reviewed",
      freshness: "fresh",
      tags: ["pricing", "plans"],
    });
    expect(node("research/churn.md")?.tier).toBe("machine-confirmed");
    expect(node("decisions/annual-plans.md")?.freshness).toBe("stale");
    expect(node("index.md")?.role).toBe("index");
  });

  it("uses per-note signals", () => {
    const signals = (noteId: string): VerificationSignals => ({
      humanEntries: { confirmed: [] },
      note: { noteId, version: 2 },
      checks: [{ noteId, by: "codex/1.4", at: NOW, version: 2, result: "fail" }],
    });
    const withSignals = buildGraphData(workspace, { now: NOW, signals });
    const competitors = withSignals.nodes.find(
      (entry) => entry.key === id("research/competitors.md"),
    );
    expect(competitors?.attributes.state).toBe("conflict");
    // with no signed events, pricing's human entry is unconfirmed: not verified by a person
    const pricing = withSignals.nodes.find((entry) => entry.key === id("research/pricing.md"));
    expect(pricing?.attributes).toMatchObject({
      tier: "human-reviewed",
      confirmedTier: "machine-confirmed",
    });
  });

  it("has one edge per linked pair, with the link count and kinds", () => {
    const edge = (from: string, to: string) =>
      data.edges.find((entry) => entry.source === id(from) && entry.target === id(to));
    expect(edge("research/pricing.md", "decisions/annual-plans.md")?.attributes).toEqual({
      count: 1,
      kinds: ["wikilink"],
      embed: false,
    });
    expect(edge("research/pricing.md", "research/churn.md")?.attributes.kinds).toEqual([
      "markdown",
    ]);
    expect(edge("research/pricing.md", "research/churn.md")?.key).toBe(
      graphEdgeKey(id("research/pricing.md"), id("research/churn.md")),
    );
    const keys = data.edges.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    const nodeKeys = new Set(data.nodes.map((entry) => entry.key));
    expect(
      data.edges.every((entry) => nodeKeys.has(entry.source) && nodeKeys.has(entry.target)),
    ).toBe(true);
  });

  it("counts distinct links in and out", () => {
    expect(node("research/pricing.md")).toMatchObject({ linksOut: 2 });
    expect(node("research/pricing.md")?.linksIn).toBe(
      new Set((workspace.backlinks.get(id("research/pricing.md")) ?? []).map((link) => link.from))
        .size,
    );
  });

  it("adds ghost nodes on request", () => {
    const withGhosts = buildGraphData(workspace, { now: NOW, signals: TRUST, includeGhosts: true });
    const ghosts = withGhosts.nodes.filter((entry) => entry.attributes.ghost);
    const quarterly = ghosts.find((entry) => entry.attributes.ghostTarget === "Quarterly targets");
    expect(quarterly?.attributes).toMatchObject({
      label: "Quarterly targets",
      path: null,
      tier: null,
      state: null,
      linksIn: 1,
    });
    expect(
      withGhosts.edges.some(
        (entry) =>
          entry.source === id("decisions/annual-plans.md") && entry.target === quarterly?.key,
      ),
    ).toBe(true);
  });

  it("keeps node and edge keys unique whatever the ids hold", () => {
    const tricky = createWorkspace([
      { id: "ghost:missing", path: "a.md", text: "[[missing]] [[b]]\n" },
      { id: "a->b", path: "b.md", text: "[[c]]\n" },
      { id: "a", path: "c.md", text: "[[a->b]] [[missing]]\n" },
      { id: "b->c", path: "d.md", text: "[[b]]\n" },
    ]);
    const graph = buildGraphData(tricky, { now: NOW, signals: TRUST, includeGhosts: true });
    const nodeKeys = graph.nodes.map((entry) => entry.key);
    expect(new Set(nodeKeys).size).toBe(nodeKeys.length);
    const ghost = graph.nodes.find((entry) => entry.attributes.ghost);
    expect(ghost?.key).not.toBe("ghost:missing");
    expect(graph.nodes.find((entry) => entry.key === "ghost:missing")?.attributes.ghost).toBe(
      false,
    );
    const edgeKeys = graph.edges.map((entry) => entry.key);
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
    expect(graphEdgeKey("a->b", "c")).not.toBe(graphEdgeKey("a", "b->c"));
  });
});
