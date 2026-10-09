// Matching the signals from outside the frontmatter: signed events to `human:` entries, and check
// records to the note's current version.
import { type Instant, readTimestamp, toEpochMs } from "../time/index.js";
import { actorKind, claimsHuman } from "../trust/provenance.js";
import type {
  CheckAssessment,
  CheckRecordSignal,
  HumanEntryRef,
  NoteVersionRef,
  VerificationSignals,
} from "./types.js";

/** Reads a signal's time: an OKF timestamp string, a `Date` or epoch milliseconds. */
export function readSignalTime(at: string | Instant): { raw: string | null; time: number | null } {
  if (typeof at === "string") return readTimestamp(at);
  const time = toEpochMs(at);
  return { raw: time === null ? null : new Date(time).toISOString(), time };
}

/**
 * The identity of a `{ by, at }` entry: the actor plus the instant, so `2026-09-30T12:00:00Z` and
 * `2026-09-30T14:00:00+02:00` are the same entry. A time that isn't a date is compared as written.
 */
export function verifiedEntryKey(by: string, at: string | Instant | null): string {
  if (at === null) return `${by.trim()}\n`;
  const { raw, time } = readSignalTime(at);
  return `${by.trim()}\n${time === null ? (raw ?? "") : String(time)}`;
}

/**
 * The keys of the `human:` entries signed events confirm for this note at its current version,
 * or `null` in `"trust-frontmatter"` mode (every entry counts). An event for another note, or for
 * a later version than the current one, confirms nothing.
 */
export function confirmedKeys(signals: VerificationSignals): Set<string> | null {
  if (signals.humanEntries === "trust-frontmatter") return null;
  const keys = new Set<string>();
  // the types require both; a caller without them (plain JS, bad data) gets no confirmations
  const note = signals.note as NoteVersionRef | undefined;
  const confirmed = (signals.humanEntries as { confirmed?: Iterable<HumanEntryRef> } | undefined)
    ?.confirmed;
  if (note === undefined || confirmed === undefined) return keys;
  const { noteId, version } = note;
  for (const entry of confirmed) {
    if (entry.noteId !== noteId || !(entry.version <= version)) continue;
    keys.add(verifiedEntryKey(entry.by, entry.at));
  }
  return keys;
}

/** Whether a dated check is for the current change: at or after `generated.at`. */
export type ChangeMatcher = (
  time: number | null,
) => "counted" | "before-change" | "invalid-date" | "change-date-unknown";

export function changeMatcher(change: { readonly time: number | null } | null): ChangeMatcher {
  return (time) => {
    if (time === null) return "invalid-date";
    if (change === null) return "counted";
    if (change.time === null) return "change-date-unknown";
    return time >= change.time ? "counted" : "before-change";
  };
}

/**
 * Assesses unapplied check records. A record counts for the current version (by note and version
 * when known, by time otherwise); per agent only the latest counting record stands, and it is
 * `counted` when it passed and `failed` when it didn't. `supersedeAcrossSources` then compares
 * the survivors with the agents' `verified` entries.
 */
export function assessRecords(
  records: readonly CheckRecordSignal[],
  note: NoteVersionRef | undefined,
  matchChange: ChangeMatcher,
): CheckAssessment[] {
  const assessed = records.map((record): CheckAssessment => {
    const by = record.by.trim();
    const { raw, time } = readSignalTime(record.at);
    const base = {
      source: "check-record" as const,
      by,
      kind: actorKind(by),
      at: raw,
      time,
      record,
    };
    if (claimsHuman(by)) return { ...base, status: "invalid-actor" };
    if (note !== undefined) {
      const current = record.noteId === note.noteId && record.version === note.version;
      return { ...base, status: current ? "counted" : "other-version" };
    }
    return { ...base, status: matchChange(time) };
  });
  return latestPerAgent(assessed).map((check) =>
    check.status === "counted" && check.record?.result !== "pass"
      ? { ...check, status: "failed" }
      : check,
  );
}

const standing = (check: CheckAssessment) =>
  check.status === "counted" || check.status === "failed";

/**
 * Keeps each agent's latest standing check and marks the others `superseded`: by time, then
 * `verified` entries over records (an entry is a check already written in), then list order.
 */
export function latestPerAgent(checks: readonly CheckAssessment[]): CheckAssessment[] {
  const rank = (check: CheckAssessment) => (check.source === "frontmatter" ? 1 : 0);
  const latest = new Map<string, number>();
  checks.forEach((check, i) => {
    if (check.kind !== "agent" || check.source === "authorship" || !standing(check)) return;
    const current = latest.get(check.by);
    const previous = current === undefined ? undefined : checks[current];
    const time = check.time ?? -Infinity;
    const previousTime = previous?.time ?? -Infinity;
    if (
      previous === undefined ||
      time > previousTime ||
      (time === previousTime && rank(check) >= rank(previous))
    ) {
      latest.set(check.by, i);
    }
  });
  return checks.map((check, i) =>
    check.kind === "agent" &&
    check.source !== "authorship" &&
    standing(check) &&
    latest.get(check.by) !== i
      ? { ...check, status: "superseded" }
      : check,
  );
}
