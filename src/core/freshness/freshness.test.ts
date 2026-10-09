import { describe, expect, it } from "vitest";

import { fixtureId, loadFixtureWorkspace } from "../../../test/fixture-workspace.js";
import {
  expiringNotes,
  freshnessOf,
  freshnessTimerDelay,
  isStale,
  MAX_TIMER_DELAY_MS,
  nextFreshnessChange,
  staleNotes,
} from "../index.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 12);
const workspace = loadFixtureWorkspace();
const notes = [...workspace.notes.values()];

describe("freshnessOf", () => {
  it("never makes a note without stale_after stale", () => {
    expect(freshnessOf({}, { now: NOW })).toEqual({
      status: "none",
      staleAfter: null,
      staleAt: null,
      remainingMs: null,
      window: null,
    });
    expect(freshnessOf({ stale_after: null }, { now: Date.UTC(3000, 0) }).status).toBe("none");
  });

  it("is stale at and after stale_after", () => {
    const frontmatter = { stale_after: "2026-09-30T12:00:00Z" };
    expect(freshnessOf(frontmatter, { now: NOW }).status).toBe("stale");
    expect(freshnessOf(frontmatter, { now: NOW + 1 }).remainingMs).toBe(-1);
    expect(freshnessOf(frontmatter, { now: NOW - 1 }).status).toBe("due-soon");
    expect(isStale(frontmatter, { now: new Date(NOW) })).toBe(true);
  });

  it("puts a date in the smallest window it falls into", () => {
    const at = (days: number) => ({ stale_after: new Date(NOW + days * DAY).toISOString() });
    expect(freshnessOf(at(3), { now: NOW })).toMatchObject({ status: "due-soon", window: 7 });
    expect(freshnessOf(at(7), { now: NOW })).toMatchObject({ status: "due-soon", window: 7 });
    expect(freshnessOf(at(8), { now: NOW })).toMatchObject({ status: "due-soon", window: 30 });
    expect(freshnessOf(at(31), { now: NOW })).toMatchObject({ status: "fresh", window: null });
    expect(freshnessOf(at(31), { now: NOW, windows: [60, 1] })).toMatchObject({
      status: "due-soon",
      window: 60,
    });
  });

  it("compares instants, whatever the time zone a date is written in", () => {
    // 2026-10-01T01:00+02:00 is 2026-09-30T23:00Z: stale at 23:00Z, not at local midnight
    const frontmatter = { stale_after: "2026-10-01T01:00:00+02:00" };
    expect(freshnessOf(frontmatter, { now: Date.UTC(2026, 8, 30, 22, 59) }).status).toBe(
      "due-soon",
    );
    expect(freshnessOf(frontmatter, { now: Date.UTC(2026, 8, 30, 23) }).status).toBe("stale");
  });

  it("keeps a note with a bare date fresh through that whole UTC day", () => {
    const frontmatter = { stale_after: "2026-10-01" };
    expect(freshnessOf(frontmatter, { now: NOW }).staleAt).toBe(Date.UTC(2026, 9, 2));
    expect(isStale(frontmatter, { now: Date.UTC(2026, 9, 1, 23, 59, 59, 999) })).toBe(false);
    expect(isStale(frontmatter, { now: Date.UTC(2026, 9, 2) })).toBe(true);
    expect(freshnessOf(frontmatter, { now: NOW }).staleAfter).toBe("2026-10-01");
    // a date-time is exact, midnight included
    expect(isStale({ stale_after: "2026-10-01T00:00:00Z" }, { now: Date.UTC(2026, 9, 1) })).toBe(
      true,
    );
  });

  it("reports malformed dates as invalid, without throwing, and never as stale", () => {
    for (const value of ["soon", "2026-02-30", 42, true, ["2026-01-01"], { at: 1 }]) {
      const freshness = freshnessOf({ stale_after: value }, { now: NOW });
      expect(freshness.status).toBe("invalid");
      expect(freshness.staleAt).toBeNull();
    }
    expect(freshnessOf({ stale_after: "soon" }, { now: NOW }).staleAfter).toBe("soon");
  });

  it("refuses an invalid now", () => {
    expect(() => freshnessOf({}, { now: new Date("nope") })).toThrow(RangeError);
    expect(() => freshnessOf({}, { now: Number.NaN })).toThrow(RangeError);
  });
});

describe("workspace lists", () => {
  const paths = (list: readonly { path: string }[]) => list.map((note) => note.path);

  it("lists the stale notes of the fixture workspace", () => {
    expect(paths(staleNotes(notes, { now: NOW }))).toEqual(["decisions/annual-plans.md"]);
  });

  it("lists the notes expiring within 7 and 30 days, soonest first", () => {
    const now = Date.UTC(2026, 11, 20); // churn goes stale on 2026-12-31
    expect(paths(expiringNotes(notes, 7, { now }))).toEqual([]);
    expect(paths(expiringNotes(notes, 30, { now }))).toEqual(["research/churn.md"]);
    const later = Date.UTC(2027, 0, 20); // custom-keys on 2027-01-31, pricing on 2027-03-31
    expect(paths(expiringNotes(notes, 30, { now: later }))).toEqual(["notes/custom-keys.md"]);
    expect(paths(expiringNotes(notes, 90, { now: later }))).toEqual([
      "notes/custom-keys.md",
      "research/pricing.md",
    ]);
  });
});

describe("nextFreshnessChange", () => {
  it("returns the next boundary after now: a window opening or a note going stale", () => {
    const churn = Date.UTC(2026, 11, 31);
    expect(nextFreshnessChange(notes, { now: NOW })).toBe(churn - 30 * DAY);
    expect(nextFreshnessChange(notes, { now: churn - 30 * DAY })).toBe(churn - 7 * DAY);
    expect(nextFreshnessChange(notes, { now: churn - 7 * DAY })).toBe(churn);
    // custom-keys has the bare date 2027-01-31: it goes stale when February starts
    expect(nextFreshnessChange(notes, { now: churn, windows: [] })).toBe(Date.UTC(2027, 1, 1));
  });

  it("re-deriving at that time changes a note's status", () => {
    const next = nextFreshnessChange(notes, { now: NOW }) ?? 0;
    const churn = workspace.notes.get(fixtureId("research/churn.md"))?.frontmatter ?? {};
    expect(freshnessOf(churn, { now: next - 1 }).status).toBe("fresh");
    expect(freshnessOf(churn, { now: next }).status).toBe("due-soon");
  });

  it("gives a timer delay that setTimeout can hold", () => {
    expect(freshnessTimerDelay(null, NOW)).toBeNull();
    expect(freshnessTimerDelay(NOW + 1000, NOW)).toBe(1000);
    expect(freshnessTimerDelay(NOW - 1000, NOW)).toBe(0);
    expect(freshnessTimerDelay(NOW + 60 * DAY, new Date(NOW))).toBe(MAX_TIMER_DELAY_MS);
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
  });

  it("is null when nothing will change", () => {
    expect(nextFreshnessChange(notes, { now: Date.UTC(2030, 0) })).toBeNull();
    expect(nextFreshnessChange([], { now: NOW })).toBeNull();
  });
});
