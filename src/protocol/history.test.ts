import { describe, expect, it } from "vitest";

import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  HISTORY_AGE_BUCKET_DAYS,
  HISTORY_RETENTION_DAYS,
  HistoryBreakdown,
  historyFreedAt,
  HistoryRetentionDays,
  HistoryRetentionResponse,
  isHistoryRetentionDays,
  HistorySettingsResponse,
  ListVersionsResponse,
  NoteVersion,
  routes,
  SetHistorySettingsRequest,
  SetHistorySettingsResponse,
} from "./index.js";
import { id, now } from "./test-fixtures.js";

/** A breakdown with `versions` older versions of `bytes` bytes in every bucket. */
function breakdown(fill: (minAgeDays: number) => { versions: number; bytes: number }) {
  return {
    buckets: HISTORY_AGE_BUCKET_DAYS.map((minAgeDays) => ({ minAgeDays, ...fill(minAgeDays) })),
    protected: { versions: 2, bytes: 2_000 },
    current: { bytes: 50_000 },
  };
}

/** One version and 2^index bytes per bucket, so every sum names its buckets. */
const SPREAD = HistoryBreakdown.parse(
  breakdown((minAgeDays) => ({
    versions: 1,
    bytes: 2 ** HISTORY_AGE_BUCKET_DAYS.indexOf(minAgeDays as never),
  })),
);

const usage = {
  usedBytes: 60_000,
  quotaBytes: 524_288_000,
  workspaceCount: 1,
  maxWorkspaces: 1,
};

describe("history periods", () => {
  it("are one day to a year, 30 days unless the owner chooses otherwise", () => {
    expect(HISTORY_RETENTION_DAYS).toEqual([1, 3, 7, 14, 30, 60, 90, 180, 365]);
    expect(DEFAULT_HISTORY_RETENTION_DAYS).toBe(30);
    expect(HISTORY_RETENTION_DAYS).toContain(DEFAULT_HISTORY_RETENTION_DAYS);
    expect(HISTORY_AGE_BUCKET_DAYS).toEqual([0, 1, 3, 7, 14, 30, 60, 90, 180, 365]);
  });

  it("accept only the listed steps", () => {
    for (const days of HISTORY_RETENTION_DAYS) expect(HistoryRetentionDays.parse(days)).toBe(days);
    for (const days of [0, 2, 29, 31, 364, 366, 30.5, -1, "30", null]) {
      expect(HistoryRetentionDays.safeParse(days).success, String(days)).toBe(false);
    }
  });

  it("are told apart from any other value by isHistoryRetentionDays", () => {
    for (const days of HISTORY_RETENTION_DAYS) expect(isHistoryRetentionDays(days)).toBe(true);
    expect(isHistoryRetentionDays(DEFAULT_HISTORY_RETENTION_DAYS)).toBe(true);
    for (const days of [0, 2, 29, 31, 364, 366, 30.5, -1, NaN, "30", null, undefined, [30]]) {
      expect(isHistoryRetentionDays(days), String(days)).toBe(false);
      expect(HistoryRetentionDays.safeParse(days).success, String(days)).toBe(false);
    }
  });
});

describe("historyFreedAt", () => {
  it("sums the buckets at or above the period, at every step", () => {
    HISTORY_RETENTION_DAYS.forEach((days, step) => {
      // buckets from this step's edge (index step + 1 in the age edges) to the last
      const kept = step + 1;
      const versions = HISTORY_AGE_BUCKET_DAYS.length - kept;
      let bytes = 0;
      for (let index = kept; index < HISTORY_AGE_BUCKET_DAYS.length; index++) bytes += 2 ** index;
      expect(historyFreedAt(SPREAD, days), `${String(days)} days`).toEqual({ versions, bytes });
    });
  });

  it("frees only the last bucket at a year, and every older version at one day", () => {
    expect(historyFreedAt(SPREAD, 365)).toEqual({ versions: 1, bytes: 512 });
    expect(historyFreedAt(SPREAD, 1)).toEqual({ versions: 9, bytes: 1022 });
    // the youngest bucket (superseded less than a day ago) is never freed by a listed step
    expect(historyFreedAt(SPREAD, 0)).toEqual({ versions: 10, bytes: 1023 });
  });

  it("puts a period between two edges with the buckets above it", () => {
    expect(historyFreedAt(SPREAD, 2)).toEqual(historyFreedAt(SPREAD, 3));
    expect(historyFreedAt(SPREAD, 31)).toEqual(historyFreedAt(SPREAD, 60));
    expect(historyFreedAt(SPREAD, 366)).toEqual({ versions: 0, bytes: 0 });
  });

  it("never counts protected versions or current versions", () => {
    const empty = HistoryBreakdown.parse(breakdown(() => ({ versions: 0, bytes: 0 })));
    for (const days of HISTORY_RETENTION_DAYS) {
      expect(historyFreedAt(empty, days)).toEqual({ versions: 0, bytes: 0 });
    }
  });
});

describe("history settings", () => {
  it("are read and set by the owner, and the period alone read by anyone, agents too", () => {
    expect(routes.getHistorySettings).toMatchObject({
      method: "GET",
      path: "/workspaces/:workspaceId/history-settings",
      auth: "session",
      body: null,
      response: HistorySettingsResponse,
    });
    expect(routes.setHistorySettings).toMatchObject({
      method: "PUT",
      path: "/workspaces/:workspaceId/history-settings",
      auth: "session",
      body: SetHistorySettingsRequest,
      response: SetHistorySettingsResponse,
    });
    expect(routes.getHistoryRetention).toMatchObject({
      method: "GET",
      path: "/workspaces/:workspaceId/history-retention",
      auth: "any",
      response: HistoryRetentionResponse,
    });
    expect(routes.getHistorySettings.params.parse({ workspaceId: id("ws") })).toEqual({
      workspaceId: id("ws"),
    });
  });

  it("answer the period, the last cleanup, the breakdown by age and the account's usage", () => {
    const settings = { retentionDays: 30, lastCleanupAt: now, breakdown: SPREAD, usage };
    expect(HistorySettingsResponse.parse(settings)).toEqual(settings);
    expect(HistorySettingsResponse.parse({ ...settings, lastCleanupAt: null }).lastCleanupAt).toBe(
      null,
    );
    for (const bad of [
      { ...settings, retentionDays: 31 },
      { ...settings, usage: undefined },
      { ...settings, breakdown: { ...SPREAD, protected: undefined } },
      { ...settings, breakdown: { ...SPREAD, current: {} } },
    ]) {
      expect(HistorySettingsResponse.safeParse(bad).success).toBe(false);
    }
  });

  it("take one bucket per age edge, in order, with counts that can't go negative", () => {
    const buckets = SPREAD.buckets;
    expect(HistoryBreakdown.safeParse({ ...SPREAD, buckets: buckets.slice(1) }).success).toBe(
      false,
    );
    expect(HistoryBreakdown.safeParse({ ...SPREAD, buckets: [...buckets].reverse() }).success).toBe(
      false,
    );
    const odd = buckets.map((bucket, index) =>
      index === 3 ? { ...bucket, minAgeDays: 5 } : bucket,
    );
    expect(HistoryBreakdown.safeParse({ ...SPREAD, buckets: odd }).success).toBe(false);
    const negative = buckets.map((bucket, index) =>
      index === 0 ? { ...bucket, bytes: -1 } : bucket,
    );
    expect(HistoryBreakdown.safeParse({ ...SPREAD, buckets: negative }).success).toBe(false);
  });

  it("set a listed period only, and say what the first cleanup freed", () => {
    expect(SetHistorySettingsRequest.parse({ retentionDays: 7 })).toEqual({ retentionDays: 7 });
    for (const bad of [{ retentionDays: 8 }, {}, { retentionDays: 7, now: true }]) {
      expect(SetHistorySettingsRequest.safeParse(bad).success).toBe(false);
    }
    const saved = { retentionDays: 7, freed: { versions: 12, bytes: 34_567 }, more: true };
    expect(SetHistorySettingsResponse.parse(saved)).toEqual(saved);
    expect(SetHistorySettingsResponse.safeParse({ ...saved, more: undefined }).success).toBe(false);
    expect(HistoryRetentionResponse.parse({ retentionDays: 365 })).toEqual({ retentionDays: 365 });
  });
});

describe("pruned versions", () => {
  const version = {
    noteId: id("note"),
    version: 3,
    sizeBytes: 1_234,
    authorId: id("acc"),
    createdAt: now,
    deleted: false,
    fromPendingId: null,
    pruned: false,
    prunedAt: null,
  };

  it("stay listed with their metadata, marked pruned with when", () => {
    const pruned = { ...version, pruned: true, prunedAt: "2026-10-31T00:00:00.000Z" };
    expect(NoteVersion.parse(version)).toEqual(version);
    expect(NoteVersion.parse(pruned)).toEqual(pruned);
    expect(ListVersionsResponse.parse({ versions: [version, pruned], hasMore: false })).toEqual({
      versions: [version, pruned],
      hasMore: false,
    });
    for (const field of ["pruned", "prunedAt"]) {
      const without = Object.fromEntries(Object.entries(version).filter(([key]) => key !== field));
      expect(NoteVersion.safeParse(without).success, field).toBe(false);
    }
  });
});
