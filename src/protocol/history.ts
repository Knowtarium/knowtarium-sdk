import { z } from "zod";

import { Usage } from "./plans.js";
import { SizeBytes, Timestamp } from "./primitives.js";
import { defineRoute } from "./route.js";

/*
 * How long a workspace keeps the older versions of its notes. A version's age counts from when the
 * next version of its note was stored (it was "superseded"), never from when it was written. Once
 * a version is older than the workspace's history period, the server removes its content (the
 * blob) and its bytes stop counting toward storage. The version stays listed (`NoteVersion.pruned`)
 * and its signed event stays, so the history still says who wrote it and when, and every signature
 * still verifies; only the content is gone (`getVersion` answers 410 `expired`).
 *
 * Never removed, whatever their age: a note's current version, the base version of an open pending
 * change, and the version before an agent's direct write that is still current (what undo brings
 * back). The setting is plain workspace metadata, not signed. Only the owner sets it (session
 * routes); agents read it (`getHistoryRetention`).
 */

/** The history periods an owner can choose, in days: one day up to one year. */
export const HISTORY_RETENTION_DAYS = [1, 3, 7, 14, 30, 60, 90, 180, 365] as const;

/** Every workspace keeps 30 days of history until its owner chooses otherwise. */
export const DEFAULT_HISTORY_RETENTION_DAYS = 30;

/** A history period from `HISTORY_RETENTION_DAYS`; any other number of days is refused. */
export const HistoryRetentionDays = z.literal(HISTORY_RETENTION_DAYS, {
  error: `Expected one of ${HISTORY_RETENTION_DAYS.join(", ")} days`,
});
export type HistoryRetentionDays = z.infer<typeof HistoryRetentionDays>;

/** True for a history period from `HISTORY_RETENTION_DAYS`, false for anything else. */
export function isHistoryRetentionDays(value: unknown): value is HistoryRetentionDays {
  return (HISTORY_RETENTION_DAYS as readonly unknown[]).includes(value);
}

/** The lower edges of the age buckets: 0, then every history period. */
export const HISTORY_AGE_BUCKET_DAYS = [0, ...HISTORY_RETENTION_DAYS] as const;
export const HistoryAgeBucketDays = z.literal(HISTORY_AGE_BUCKET_DAYS);
export type HistoryAgeBucketDays = z.infer<typeof HistoryAgeBucketDays>;

/** A number of older versions and the stored (ciphertext) bytes they take. */
export const HistoryAmount = z.object({
  versions: z.int().nonnegative(),
  bytes: SizeBytes,
});
export type HistoryAmount = z.infer<typeof HistoryAmount>;

/**
 * The older versions that could be removed whose age (time since they were superseded) is at
 * least `minAgeDays` and less than the next bucket's edge (the 365 bucket has no upper edge).
 */
export const HistoryAgeBucket = HistoryAmount.extend({ minAgeDays: HistoryAgeBucketDays });
export type HistoryAgeBucket = z.infer<typeof HistoryAgeBucket>;

/**
 * What a workspace's history holds, for the settings page to show what a shorter period frees
 * before the owner confirms it (`historyFreedAt`).
 *
 * - `buckets`: the superseded versions whose content is still stored and could be removed, by age,
 *   one bucket per edge of `HISTORY_AGE_BUCKET_DAYS` in that order (zeros included).
 * - `protected`: superseded versions kept whatever their age (an open pending change's base, the
 *   version an undo brings back); never in `buckets`.
 * - `current`: the bytes of the notes' current versions, which history never removes.
 *
 * Versions whose content was already removed count nowhere (they take no storage).
 */
export const HistoryBreakdown = z.object({
  buckets: z
    .array(HistoryAgeBucket)
    .length(HISTORY_AGE_BUCKET_DAYS.length)
    .refine(
      (buckets) =>
        buckets.every((bucket, index) => bucket.minAgeDays === HISTORY_AGE_BUCKET_DAYS[index]),
      { error: "Expected one bucket per age edge, in order" },
    ),
  protected: HistoryAmount,
  current: z.object({ bytes: SizeBytes }),
});
export type HistoryBreakdown = z.infer<typeof HistoryBreakdown>;

/**
 * What a history period of `days` would remove now: the older versions superseded at least `days`
 * days ago (every bucket with `minAgeDays >= days`). Storage after the cleanup is
 * `usage.usedBytes - historyFreedAt(breakdown, days).bytes`. At the current setting it is what the
 * next cleanup removes (usually nothing).
 */
export function historyFreedAt(breakdown: HistoryBreakdown, days: number): HistoryAmount {
  let versions = 0;
  let bytes = 0;
  for (const bucket of breakdown.buckets) {
    if (bucket.minAgeDays < days) continue;
    versions += bucket.versions;
    bytes += bucket.bytes;
  }
  return { versions, bytes };
}

/**
 * A workspace's history setting: `retentionDays`, when the last cleanup ran (null before the
 * first), what the history holds by age (`breakdown`, named so rather than "summary", which reads
 * as a content field) and the account's usage (the same as `getAccountPlan`'s), so the page can
 * show the storage a shorter period leaves.
 */
export const HistorySettingsResponse = z.object({
  retentionDays: HistoryRetentionDays,
  lastCleanupAt: Timestamp.nullable(),
  breakdown: HistoryBreakdown,
  usage: Usage,
});
export type HistorySettingsResponse = z.infer<typeof HistorySettingsResponse>;

/** The new history period, from `HISTORY_RETENTION_DAYS`. */
export const SetHistorySettingsRequest = z.strictObject({ retentionDays: HistoryRetentionDays });
export type SetHistorySettingsRequest = z.infer<typeof SetHistorySettingsRequest>;

/**
 * The setting saved. A shorter period applies at once: `freed` is what the first cleanup batch
 * removed within the request, and `more` is true when older versions remain to remove (the server
 * removes them in batches of 500 every 30 seconds). A longer or equal period runs no cleanup,
 * removes nothing and can't bring back versions already removed (`freed` is zero).
 */
export const SetHistorySettingsResponse = z.object({
  retentionDays: HistoryRetentionDays,
  freed: HistoryAmount,
  more: z.boolean(),
});
export type SetHistorySettingsResponse = z.infer<typeof SetHistorySettingsResponse>;

/** The history period alone, for agents (read-only). */
export const HistoryRetentionResponse = z.object({ retentionDays: HistoryRetentionDays });
export type HistoryRetentionResponse = z.infer<typeof HistoryRetentionResponse>;

export const historyRoutes = {
  getHistorySettings: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/history-settings",
    auth: "session",
    summary: "The workspace's history period, last cleanup, history by age and the account's usage",
    response: HistorySettingsResponse,
  }),
  setHistorySettings: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/history-settings",
    auth: "session",
    summary: "The owner sets the history period; a shorter one removes older versions at once",
    body: SetHistorySettingsRequest,
    response: SetHistorySettingsResponse,
  }),
  getHistoryRetention: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/history-retention",
    auth: "any",
    summary: "The workspace's history period alone (agents read it; only the owner sets it)",
    response: HistoryRetentionResponse,
  }),
};
