// Time as the derived views see it: an injectable "now" and frontmatter timestamps read into epoch
// milliseconds, so every comparison is between absolute instants and never depends on a time zone.
import { parseOkfTimestamp } from "../schema/timestamp.js";

/** A point in time: a `Date` or epoch milliseconds. */
export type Instant = Date | number;

/** Returns the current time in epoch milliseconds. Tests and the scheduler inject their own. */
export type Clock = () => number;

/** The real clock. */
export const systemClock: Clock = () => Date.now();

/** Epoch milliseconds of an instant, or `null` when it is an invalid date or not finite. */
export function toEpochMs(instant: Instant): number | null {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch milliseconds of an instant; throws a `RangeError` for an invalid one. */
export function requireEpochMs(instant: Instant): number {
  const ms = toEpochMs(instant);
  if (ms === null) throw new RangeError("The time is not a valid date");
  return ms;
}

/** A frontmatter timestamp as written, and as epoch milliseconds (`null` when unreadable). */
export interface ReadTimestamp {
  /** The value as written (a `Date` from YAML 1.1 becomes its ISO string); `null` when absent. */
  readonly raw: string | null;
  readonly time: number | null;
}

/**
 * Reads a frontmatter date or date-time. Never throws: a missing value gives `raw: null`, and a
 * malformed one keeps its text with `time: null`. Dates without a zone are read as UTC.
 */
export function readTimestamp(value: unknown): ReadTimestamp {
  if (value === undefined || value === null) return { raw: null, time: null };
  if (value instanceof Date) {
    const time = toEpochMs(value);
    return { raw: time === null ? "Invalid Date" : value.toISOString(), time };
  }
  if (typeof value === "string") return { raw: value, time: parseOkfTimestamp(value) };
  if (typeof value === "number" || typeof value === "boolean") {
    return { raw: String(value), time: null };
  }
  // a list or a mapping where a date belongs (never stringified: YAML aliases can nest deeply)
  return { raw: Array.isArray(value) ? "(a list)" : "(a mapping)", time: null };
}

export const DAY_MS = 86_400_000;
