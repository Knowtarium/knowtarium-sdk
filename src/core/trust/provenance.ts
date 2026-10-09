// Reading `generated` and `verified` from a note's frontmatter values, entry by entry. Unlike the
// schema (which drops a whole field when one item is invalid), this keeps every readable entry and
// reports the unreadable ones, so a single bad date never hides the other checks.
import { readTimestamp } from "../time/index.js";

/** A person (`human:<id>`), or anything else: an agent, a tool or a process (OKF §5.3). */
export type ActorKind = "human" | "agent";

/** Written with the `human:` prefix, whether or not an id follows. */
export function claimsHuman(by: string): boolean {
  return by.trim().startsWith("human:");
}

/**
 * OKF: only the `human:` prefix makes a check a person's review; every other actor is a machine.
 * A bare `human:` names no person: `readProvenance` reports it as unreadable, so it never counts.
 */
export function actorKind(by: string): ActorKind {
  return /^human:\S/.test(by.trim()) ? "human" : "agent";
}

/** A `{ by, at }` entry as read from the frontmatter. */
export interface ProvenanceEntry {
  readonly by: string;
  readonly kind: ActorKind;
  /** `at` as written; `null` when missing. */
  readonly at: string | null;
  /** `at` in epoch milliseconds; `null` when missing or malformed. */
  readonly time: number | null;
}

/** One item of `verified`, with its position in the list. */
export interface VerifiedEntry extends ProvenanceEntry {
  readonly index: number;
}

/** A `verified` item that names no actor, so it can't count for anything. */
export interface UnreadableEntry {
  readonly index: number;
  readonly message: string;
}

export interface Provenance {
  /** The current change; `null` when `generated` is missing or names no actor. */
  readonly generated: ProvenanceEntry | null;
  /** Every `verified` item with an actor, in file order (malformed dates included). */
  readonly verified: readonly VerifiedEntry[];
  readonly unreadable: readonly UnreadableEntry[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntry(value: unknown): ProvenanceEntry | null {
  if (!isRecord(value)) return null;
  const by = value["by"];
  if (typeof by !== "string" || by.trim() === "") return null;
  // `human:` without an id is neither a person nor a machine
  if (claimsHuman(by) && actorKind(by) !== "human") return null;
  const { raw, time } = readTimestamp(value["at"]);
  return { by: by.trim(), kind: actorKind(by), at: raw, time };
}

/** Reads the provenance fields of a note's frontmatter values. Never throws. */
export function readProvenance(frontmatter: Readonly<Record<string, unknown>>): Provenance {
  const generated = readEntry(frontmatter["generated"]);
  const list = frontmatter["verified"];
  const items: readonly unknown[] = Array.isArray(list) ? list : isRecord(list) ? [list] : [];
  const verified: VerifiedEntry[] = [];
  const unreadable: UnreadableEntry[] = [];
  items.forEach((item, index) => {
    const entry = readEntry(item);
    if (entry === null) {
      unreadable.push({ index, message: "This `verified` item names no actor or person (`by`)." });
    } else {
      verified.push({ ...entry, index });
    }
  });
  return { generated, verified, unreadable };
}
