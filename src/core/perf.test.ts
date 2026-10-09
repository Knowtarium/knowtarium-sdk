// Performance at 3,000 notes: building and updating the search index, searching, restoring the
// cached index, graph data and related notes. Times are medians after warm-ups; the limits are
// for a quiet CI runner, scaled to this run's measured speed unless KNOWTARIUM_PERF=strict (see
// test/perf-budget.ts). The measured times are printed for the record.
import { describe, expect, it } from "vitest";

import { budget, calibration, measure, strict } from "../../test/perf-budget.js";
import { syntheticNotes, syntheticTitle, syntheticWord } from "../../test/synthetic-workspace.js";
import {
  buildGraphData,
  createSearchIndex,
  createWorkspace,
  deriveVerification,
  relatedNotes,
  restoreSearchIndex,
  upsertNote,
  type VerificationSignals,
} from "./index.js";
import { tokenize } from "./search/terms.js";

// the library has no DOM or Node types; every test runtime has a console
declare const console: { info(message: string): void };

const COUNT = 3000;
const NOW = Date.UTC(2026, 8, 30, 12);

/** One run's result and time (for the work that runs once). */
function time<T>(run: () => T): [T, number] {
  const { ms, result } = measure(run, { warmups: 0, runs: 1 });
  return [result, ms];
}

/** The median time of several runs after a warm-up, in milliseconds. */
function median(runs: number, run: () => unknown): number {
  return measure(run, { warmups: 1, runs }).ms;
}

describe(`performance at ${String(COUNT)} notes`, { timeout: 60_000 }, () => {
  const inputs = syntheticNotes(COUNT);
  const [workspace, workspaceMs] = time(() => createWorkspace(inputs));
  const report: Record<string, number> = { "createWorkspace (not core to t-51)": workspaceMs };

  it("has a realistic number of distinct terms", () => {
    const terms = new Set<string>();
    for (const note of workspace.notes.values())
      for (const word of tokenize(note.body)) terms.add(word);
    report["distinct body terms"] = terms.size;
    expect(terms.size).toBeGreaterThan(50_000);
  });

  it("builds the search index", () => {
    const { ms, result: index } = measure(() => createSearchIndex(workspace.notes.values()), {
      warmups: 1,
      runs: 3,
    });
    report["index build, median"] = ms;
    expect(index.size).toBe(COUNT);
    expect(ms).toBeLessThan(budget(5000));
  });

  it("updates the index for one changed note, incrementally", () => {
    const index = createSearchIndex(workspace.notes.values());
    let current = workspace;
    const ms = median(21, () => {
      const note = current.notes.get("syn_7");
      if (note === undefined) throw new Error("missing");
      current = upsertNote(current, {
        id: note.id,
        path: note.path,
        text: `${note.parsed.text}\nedited ${String(Date.now())} marker\n`,
      });
      const updated = current.notes.get("syn_7");
      if (updated === undefined || index.upsert(updated) !== "updated")
        throw new Error("no update");
    });
    report["incremental update (upsertNote + index.upsert), median"] = ms;
    const indexOnly = median(21, () => {
      const note = current.notes.get("syn_9");
      if (note === undefined) throw new Error("missing");
      current = upsertNote(current, {
        ...note,
        text: `${note.parsed.text} x${String(Math.random())}`,
      });
      const updated = current.notes.get("syn_9");
      if (updated !== undefined) index.upsert(updated);
    });
    report["incremental update, second note, median"] = indexOnly;
    expect(index.search("marker")[0]?.id).toBe("syn_7");
    expect(ms).toBeLessThan(budget(50));
  });

  it("searches well under 100 ms", () => {
    const index = createSearchIndex(workspace.notes.values());
    const rare = syntheticWord(60_001);
    const queries = [
      "pricing churn",
      "retention cohort",
      "onboardin",
      "revnue forecast",
      syntheticTitle(1234),
      rare,
      rare.slice(0, 3),
      `${rare.slice(0, -1)}x`,
      "b",
    ];
    expect(index.search(syntheticTitle(1234))[0]?.id).toBe("syn_1234");
    for (const query of queries) {
      const ms = median(9, () => index.search(query));
      report[`search "${query}", median`] = ms;
      // about 20 ms on a quiet laptop; the limit leaves room for a slow CI runner
      expect(ms, query).toBeLessThan(budget(100));
    }
  });

  it("serializes and restores the index", () => {
    const index = createSearchIndex(workspace.notes.values());
    const [serialized, serializeMs] = time(() => index.serialize());
    const { ms: restoreMs, result: restored } = measure(
      () => restoreSearchIndex(serialized, workspace.notes.values()),
      { warmups: 1, runs: 3 },
    );
    report["serialize"] = serializeMs;
    report["restore (unchanged notes)"] = restoreMs;
    report["serialized size, KB"] = Math.round(serialized.length / 1024);
    expect(restored.rebuilt).toBe(false);
    expect(restored.changes.unchanged).toBe(COUNT);
    expect(restoreMs).toBeLessThan(budget(5000));
  });

  it("derives every note's state, the graph data and related notes", () => {
    const signals = (noteId: string): VerificationSignals => ({
      humanEntries: {
        confirmed: [{ noteId, version: 1, by: "human:sara", at: "2026-09-01T09:00:00Z" }],
      },
      note: { noteId, version: 1 },
    });
    const [, stateMs] = time(() => {
      for (const note of workspace.notes.values()) {
        deriveVerification(note.frontmatter, { now: NOW, ...signals(note.id) });
      }
    });
    const { ms: graphMs, result: graph } = measure(
      () => buildGraphData(workspace, { now: NOW, signals }),
      { warmups: 1, runs: 3 },
    );
    const relatedMs = median(9, () => relatedNotes(workspace, "syn_100"));
    report["verification states, all notes"] = stateMs;
    report["graph data"] = graphMs;
    report["related notes, median"] = relatedMs;
    expect(graph.nodes).toHaveLength(COUNT);
    expect(graphMs).toBeLessThan(budget(2000));
    expect(relatedMs).toBeLessThan(budget(100));
  });

  it("prints the numbers", () => {
    console.info(
      `performance at ${String(COUNT)} notes (ms; ${strict ? "strict limits" : `limits scaled by ${calibration().toFixed(2)} x 3`}):\n` +
        Object.entries(report)
          .map(([name, ms]) => `  ${name}: ${String(ms)}`)
          .join("\n"),
    );
    expect(Object.keys(report).length).toBeGreaterThan(5);
  });
});
