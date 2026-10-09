import { buildThreads, type CommentEntry, type CommentThreads } from "./comments.js";
import type { CheckFindings, HistoryEvent, SignatureStatus } from "./events.js";

/** A stored version of a note, as the server lists it. */
export interface VersionInfo {
  readonly version: number;
  readonly authorId: string;
  readonly createdAt: string;
  readonly deleted: boolean;
  /** The pending change it was approved from, if any. */
  readonly fromPendingId: string | null;
  /**
   * Its content was removed after the workspace's history period: the entry and its signed event
   * stay, the text can't be opened (absent: not removed). The server's word, unsigned: the
   * timeline takes it only for a superseded version that had content (see `buildTimeline`).
   */
  readonly pruned?: boolean;
  /** When its content was removed, if it was. */
  readonly prunedAt?: string | null;
}

/** A typed history event with what the server says about it. */
export interface HistoryEventEntry {
  readonly id: string;
  /** The workspace version the event was stored at. */
  readonly seq: number;
  readonly createdAt: string;
  readonly authorId: string;
  /**
   * The agent token that posted it, as the server asserts (null for a person's): attribution
   * for display, not proof.
   */
  readonly authorTokenId: string | null;
  /** The note version it refers to, as the server stored it. */
  readonly noteVersion: number | null;
  readonly event: HistoryEvent;
  /** The actor its record names, if it has one. */
  readonly actor?: string;
  readonly signature: SignatureStatus;
  /**
   * For an agent's direct write (`agent_edited`) whose signature verified: the agent token and
   * whether it was revoked since (its earlier versions stay valid, flagged).
   */
  readonly agent?: { readonly tokenId: string; readonly revoked: boolean };
}

/** An agent's check record (not yet written into the note, or applied, or dismissed). */
export interface CheckEntry {
  readonly id: string;
  readonly noteVersion: number;
  readonly authorId: string;
  /**
   * The agent token that posted it, as the server asserts (null for a person's): attribution
   * for display, not proof.
   */
  readonly authorTokenId: string | null;
  readonly createdAt: string;
  readonly status: "unapplied" | "applied" | "dismissed";
  /** The workspace version of the record's last change. */
  readonly seq: number;
  /** The decrypted findings; null when unreadable. */
  readonly findings: CheckFindings | null;
  readonly signature: SignatureStatus;
}

/** One line of a note's timeline. */
export type TimelineEntry =
  | {
      readonly kind: "version";
      readonly at: string;
      readonly version: VersionInfo;
      /**
       * The signed event that made the version: a person's `edited`, `approved`,
       * `check_applied` or `deleted`, or an agent's `agent_edited`.
       */
      readonly event: HistoryEventEntry | null;
      /** The version's signature: its event's, or `unconfirmed` when no signed event backs it. */
      readonly signature: SignatureStatus;
      /**
       * Its content was removed after the history period: show who wrote it and when (its signed
       * event still verifies) without a way to open, restore or compare it.
       */
      readonly pruned: boolean;
    }
  | { readonly kind: "event"; readonly at: string; readonly event: HistoryEventEntry }
  | { readonly kind: "comment"; readonly at: string; readonly comment: CommentEntry }
  | { readonly kind: "check"; readonly at: string; readonly check: CheckEntry };

/** Everything the timeline of one note is built from, decrypted and verified by the client. */
export interface TimelineInput {
  readonly versions: readonly VersionInfo[];
  readonly events: readonly HistoryEventEntry[];
  readonly comments?: readonly CommentEntry[];
  readonly checks?: readonly CheckEntry[];
}

/** A note's timeline, with its comment threads. */
export interface Timeline {
  /** Oldest first. */
  readonly entries: readonly TimelineEntry[];
  /** The newest version, if any. */
  readonly latest: VersionInfo | null;
  readonly threads: CommentThreads;
  /** Entries that claim a person without a valid signature, or whose signature fails. */
  readonly untrusted: number;
  /** Versions whose content was removed after the history period. */
  readonly pruned: number;
}

/** The version a signed write event made, if it is one (a person's, or an agent's direct one). */
function writeVersion(event: HistoryEvent): number | null {
  return event.type === "edited" ||
    event.type === "approved" ||
    event.type === "check_applied" ||
    event.type === "agent_edited" ||
    event.type === "deleted"
    ? event.version
    : null;
}

const KIND_ORDER: Record<TimelineEntry["kind"], number> = {
  version: 0,
  event: 1,
  check: 2,
  comment: 3,
};

/** The workspace version an entry was stored at, when known. */
function seqOf(entry: TimelineEntry): number | null {
  switch (entry.kind) {
    case "version":
      return entry.event?.seq ?? null;
    case "event":
      return entry.event.seq;
    case "comment":
      return entry.comment.seq;
    case "check":
      return entry.check.seq;
  }
}

/** Epoch milliseconds of an entry's time; unreadable dates sort last. */
function timeOf(entry: TimelineEntry): number {
  const time = Date.parse(entry.at);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

const byTime = (a: TimelineEntry, b: TimelineEntry) =>
  timeOf(a) - timeOf(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

/**
 * Orders entries by the workspace version they were stored at (`seq`, which the server assigns
 * in order, unlike clocks). An entry without one (a version no signed event backs) goes after the
 * last ordered entry that isn't later than it in time; unreadable dates go last.
 */
function sortTimeline(entries: TimelineEntry[]): void {
  const ordered = entries
    .filter((entry) => seqOf(entry) !== null)
    .sort((a, b) => (seqOf(a) ?? 0) - (seqOf(b) ?? 0) || byTime(a, b));
  const loose = entries.filter((entry) => seqOf(entry) === null).sort(byTime);
  const result: TimelineEntry[] = [];
  let next = 0;
  for (const entry of ordered) {
    for (let candidate = loose[next]; candidate !== undefined && byTime(candidate, entry) < 0;) {
      result.push(candidate);
      next++;
      candidate = loose[next];
    }
    result.push(entry);
  }
  result.push(...loose.slice(next));
  entries.splice(0, entries.length, ...result);
}

/**
 * Builds a note's timeline: its versions (each with the signed event that made it), the other
 * events (rejections, proposals, checks, restores), check records and comments, oldest first,
 * with comment threads and a count of entries that aren't trustworthy. A version whose content
 * was removed after the history period is an entry like any other, marked `pruned`. That mark is
 * the server's unsigned word, so it is taken only where pruning can happen: never for the newest
 * version listed (a note's current version is never removed) nor a delete marker (no content).
 * Elsewhere a false mark only hides content the server could withhold anyway; opening a version
 * still downloads and verifies it, or fails with `VersionPrunedError`.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const writes = new Map<number, HistoryEventEntry>();
  const others: HistoryEventEntry[] = [];
  for (const entry of input.events) {
    const version = writeVersion(entry.event);
    if (version === null) {
      others.push(entry);
      continue;
    }
    // a version's own event: the verified one wins when the server lists more than one
    if (writes.get(version)?.signature !== "verified") writes.set(version, entry);
  }
  const latest = input.versions.reduce<VersionInfo | null>(
    (best, version) => (best === null || version.version > best.version ? version : best),
    null,
  );
  const isPruned = (version: VersionInfo) =>
    version.pruned === true && !version.deleted && version !== latest;
  const entries: TimelineEntry[] = [
    ...input.versions.map((version): TimelineEntry => {
      const event = writes.get(version.version) ?? null;
      return {
        kind: "version",
        at: version.createdAt,
        version,
        event,
        signature: event?.signature ?? "unconfirmed",
        pruned: isPruned(version),
      };
    }),
    ...others.map((event): TimelineEntry => ({ kind: "event", at: event.createdAt, event })),
    ...(input.checks ?? []).map((check): TimelineEntry => ({
      kind: "check",
      at: check.createdAt,
      check,
    })),
    ...(input.comments ?? []).map((comment): TimelineEntry => ({
      kind: "comment",
      at: comment.createdAt,
      comment,
    })),
  ];
  sortTimeline(entries);
  const signatureOf = (entry: TimelineEntry): SignatureStatus =>
    entry.kind === "version"
      ? entry.signature
      : entry.kind === "event"
        ? entry.event.signature
        : entry.kind === "check"
          ? entry.check.signature
          : entry.comment.signature;
  return {
    entries,
    latest,
    threads: buildThreads(input.comments ?? []),
    untrusted: entries.filter((entry) => {
      const signature = signatureOf(entry);
      return signature === "invalid" || signature === "unconfirmed";
    }).length,
    pruned: input.versions.filter(isPruned).length,
  };
}

/**
 * The newest version whose state is fully verified (O-18's rule, decided by the caller with
 * `deriveVerification`), or null when none is.
 */
export function lastFullyVerifiedVersion(
  versions: readonly { readonly version: number; readonly fullyVerified: boolean }[],
): number | null {
  let best: number | null = null;
  for (const { version, fullyVerified } of versions) {
    if (fullyVerified && (best === null || version > best)) best = version;
  }
  return best;
}
