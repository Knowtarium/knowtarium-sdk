// Freshness from `stale_after` (OKF §5.5): a note is stale once the current time reaches it, and
// "due soon" while it falls inside one of the look-ahead windows (7 and 30 days by default).
import { DAY_MS, type Instant, readTimestamp, requireEpochMs } from "../time/index.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When a note goes stale. A date-time is that instant; a bare date (`2027-01-31`) means the note
 * is good through that whole day, so it goes stale at the start of the next UTC day.
 */
export function readStaleAfter(value: unknown): { raw: string | null; time: number | null } {
  const { raw, time } = readTimestamp(value);
  if (time !== null && typeof value === "string" && DATE_ONLY.test(value.trim())) {
    return { raw, time: time + DAY_MS };
  }
  return { raw, time };
}

/**
 * The longest delay `setTimeout` takes: browsers, Node and Workers store it as a signed 32-bit
 * number of milliseconds, and a longer one fires at once. Timers for later changes re-arm.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The delay for a timer that re-derives freshness at `next` (from `nextFreshnessChange`): never
 * negative, and at most `MAX_TIMER_DELAY_MS` (about 24.8 days), after which the caller simply
 * asks for the next change again. `null` when there is nothing to wait for.
 */
export function freshnessTimerDelay(next: number | null, now: Instant): number | null {
  if (next === null) return null;
  return Math.min(Math.max(0, next - requireEpochMs(now)), MAX_TIMER_DELAY_MS);
}

/** The look-ahead windows, in days, for "due soon" lists. */
export const DUE_SOON_WINDOWS = [7, 30] as const;

/**
 * - `none`: no `stale_after`, so the note never goes stale
 * - `invalid`: `stale_after` is set but isn't a date (never treated as stale)
 * - `fresh`: `stale_after` is further away than the largest window
 * - `due-soon`: it falls inside a window
 * - `stale`: the current time is at or past it
 */
export type FreshnessStatus = "none" | "invalid" | "fresh" | "due-soon" | "stale";

export interface Freshness {
  readonly status: FreshnessStatus;
  /** `stale_after` as written; `null` when absent. */
  readonly staleAfter: string | null;
  /** When the note goes stale, in epoch milliseconds; `null` when absent or invalid. */
  readonly staleAt: number | null;
  /** Milliseconds until stale (0 or less once stale); `null` without a valid `stale_after`. */
  readonly remainingMs: number | null;
  /** The smallest window (in days) the date falls inside, for `due-soon`; otherwise `null`. */
  readonly window: number | null;
}

export interface FreshnessOptions {
  /** The current time (inject a clock's value; see `systemClock`). */
  readonly now: Instant;
  /** Look-ahead windows in days, any order. Defaults to `DUE_SOON_WINDOWS`. */
  readonly windows?: readonly number[];
}

function sortedWindows(windows: readonly number[] | undefined): number[] {
  const list = (windows ?? DUE_SOON_WINDOWS).filter((days) => Number.isFinite(days) && days > 0);
  return [...list].sort((a, b) => a - b);
}

/** The freshness of a note from its frontmatter values. Never throws for a malformed date. */
export function freshnessOf(
  frontmatter: Readonly<Record<string, unknown>>,
  options: FreshnessOptions,
): Freshness {
  const now = requireEpochMs(options.now);
  const { raw, time } = readStaleAfter(frontmatter["stale_after"]);
  if (raw === null) {
    return { status: "none", staleAfter: null, staleAt: null, remainingMs: null, window: null };
  }
  if (time === null) {
    return { status: "invalid", staleAfter: raw, staleAt: null, remainingMs: null, window: null };
  }
  const remainingMs = time - now;
  const base = { staleAfter: raw, staleAt: time, remainingMs };
  if (remainingMs <= 0) return { ...base, status: "stale", window: null };
  const window = sortedWindows(options.windows).find((days) => remainingMs <= days * DAY_MS);
  return window === undefined
    ? { ...base, status: "fresh", window: null }
    : { ...base, status: "due-soon", window };
}

/** Whether a note is stale now. Notes without a valid `stale_after` never are. */
export function isStale(
  frontmatter: Readonly<Record<string, unknown>>,
  options: FreshnessOptions,
): boolean {
  return freshnessOf(frontmatter, options).status === "stale";
}

/** Anything with frontmatter values, such as a workspace `Note`. */
export interface HasFrontmatter {
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

/** The stale notes, the longest stale first. */
export function staleNotes<T extends HasFrontmatter>(
  notes: Iterable<T>,
  options: FreshnessOptions,
): T[] {
  return byStaleAt(notes, options, (freshness) => freshness.status === "stale");
}

/**
 * The notes that go stale within the next `days` days (and aren't stale yet), soonest first: the
 * "expiring in 7 days" and "in 30 days" lists.
 */
export function expiringNotes<T extends HasFrontmatter>(
  notes: Iterable<T>,
  days: number,
  options: FreshnessOptions,
): T[] {
  return byStaleAt(
    notes,
    options,
    (freshness) =>
      freshness.remainingMs !== null &&
      freshness.remainingMs > 0 &&
      freshness.remainingMs <= days * DAY_MS,
  );
}

function byStaleAt<T extends HasFrontmatter>(
  notes: Iterable<T>,
  options: FreshnessOptions,
  keep: (freshness: Freshness) => boolean,
): T[] {
  const kept: [T, number][] = [];
  for (const note of notes) {
    const freshness = freshnessOf(note.frontmatter, options);
    if (freshness.staleAt !== null && keep(freshness)) kept.push([note, freshness.staleAt]);
  }
  return kept.sort((a, b) => a[1] - b[1]).map(([note]) => note);
}

/**
 * The next time, strictly after `now`, at which any note's freshness changes (it enters a window
 * or goes stale), or `null` when nothing will. The web app sets one timer for it and re-derives
 * then, instead of polling; pass it through `freshnessTimerDelay`, since it can be months away.
 */
export function nextFreshnessChange(
  notes: Iterable<HasFrontmatter>,
  options: FreshnessOptions,
): number | null {
  const now = requireEpochMs(options.now);
  const windows = sortedWindows(options.windows);
  let next: number | null = null;
  for (const note of notes) {
    const { time } = readStaleAfter(note.frontmatter["stale_after"]);
    if (time === null || time <= now) continue;
    for (const boundary of [time, ...windows.map((days) => time - days * DAY_MS)]) {
      if (boundary > now && (next === null || boundary < next)) next = boundary;
    }
  }
  return next;
}
