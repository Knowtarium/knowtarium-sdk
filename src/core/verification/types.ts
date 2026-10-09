import type { Freshness, FreshnessOptions } from "../freshness/freshness.js";
import type { Instant } from "../time/index.js";
import type { ActorKind, ProvenanceEntry, VerifiedEntry } from "../trust/provenance.js";
import type { TrustTierResult } from "../trust/tier.js";

/**
 * Knowtarium's verification states, on top of the OKF trust tier:
 *
 * - `waiting-for-human`: no person has checked the note since its last change
 * - `agent-check-pending`: a person has, no agent has yet
 * - `fully-verified`: both have (an approved agent change is fully verified: the agent wrote it,
 *   the person approved it)
 * - `conflict`: an agent's check of the current version failed
 * - `stale`: past `stale_after`, whatever the checks say
 */
export type VerificationState =
  "waiting-for-human" | "agent-check-pending" | "fully-verified" | "conflict" | "stale";

/** The state the checks alone give, before `stale` overrides it. */
export type CheckState = Exclude<VerificationState, "stale">;

/** A note at one version. */
export interface NoteVersionRef {
  readonly noteId: string;
  readonly version: number;
}

/**
 * A person's `verified` entry that a verified signed event backs: the event's note and the
 * version it produced (the approval or edit that added the entry), plus the entry's actor and
 * time. It confirms the entry for that note at that version and every later one.
 */
export interface HumanEntryRef extends NoteVersionRef {
  readonly by: string;
  readonly at: string | Instant;
}

/**
 * An agent's check record (`record_check`) that no client has written into the note yet. Passing
 * records count as the agent's check until one is applied; failing ones are conflicts.
 */
export interface CheckRecordSignal extends NoteVersionRef {
  /** The record's id, to find it again in the review queue. */
  readonly id?: string;
  /** The agent that checked (a `human:` actor here is refused: people don't file check records). */
  readonly by: string;
  readonly at: string | Instant;
  readonly result: "pass" | "fail";
}

interface SignalsBase {
  /** Check records for this note that aren't applied yet. */
  readonly checks?: readonly CheckRecordSignal[];
}

/**
 * The web app and the CLI: a `human:` entry counts only when a signed event confirms it for this
 * note at this version or an earlier one. Any other `human:` entry is "unconfirmed" (an agent
 * holding the workspace key could have written it) and doesn't count.
 */
export interface ConfirmedSignals extends SignalsBase {
  readonly humanEntries: { readonly confirmed: Iterable<HumanEntryRef> };
  /** The note and its current version: signed events and check records must match them. */
  readonly note: NoteVersionRef;
}

/**
 * Plain OKF import and export only, where no signed events exist: every `human:` entry counts
 * as written. Never use it for synced workspaces.
 */
export interface TrustFrontmatterSignals extends SignalsBase {
  readonly humanEntries: "trust-frontmatter";
  /** The note and its version, when known. Without it, check records are matched by time. */
  readonly note?: NoteVersionRef;
}

/**
 * Signals from outside the frontmatter. The human-entry mode is required, so a caller can never
 * trust unsigned `human:` entries by leaving something out.
 */
export type VerificationSignals = ConfirmedSignals | TrustFrontmatterSignals;

export type VerificationOptions = VerificationSignals & FreshnessOptions;

/** Where a check came from. `authorship` is an agent's own change, which counts as its check. */
export type CheckSource = "frontmatter" | "authorship" | "check-record";

/**
 * What became of a check:
 *
 * - `counted`: it counts toward the state
 * - `failed`: a failing check record, which makes the note a conflict
 * - `before-change`: its `at` is before `generated.at`, so it checked an older version
 * - `invalid-date`: its `at` is missing or not a date
 * - `change-date-unknown`: `generated.at` is missing or not a date, so nothing can be matched to it
 * - `unconfirmed`: a `human:` entry without a matching signed event
 * - `other-version`: a check record for another note or another version of it
 * - `superseded`: the same agent checked again later (in a record or in `verified`)
 * - `invalid-actor`: a check record claiming to be by a person
 */
export type CheckStatus =
  | "counted"
  | "failed"
  | "before-change"
  | "invalid-date"
  | "change-date-unknown"
  | "unconfirmed"
  | "other-version"
  | "superseded"
  | "invalid-actor";

export interface CheckAssessment {
  readonly source: CheckSource;
  readonly by: string;
  readonly kind: ActorKind;
  /** The time as written (`null` when missing). */
  readonly at: string | null;
  readonly time: number | null;
  readonly status: CheckStatus;
  /** The item's position in `verified`, for `frontmatter` checks. */
  readonly index?: number;
  /** The record, for `check-record` checks. */
  readonly record?: CheckRecordSignal;
}

export type VerificationReasonCode =
  | "stale"
  | "conflict"
  | "no-change-recorded"
  | "change-date-unknown"
  | "human-check"
  | "no-human-check"
  | "unconfirmed-human-check"
  | "agent-authored"
  | "agent-check"
  | "agent-check-unapplied"
  | "no-agent-check"
  | "outdated-checks"
  | "invalid-date";

/** One line of the explanation, first the ones that decide the state. */
export interface VerificationReason {
  readonly code: VerificationReasonCode;
  readonly message: string;
  readonly by?: string;
  readonly at?: string | null;
}

export interface VerificationResult {
  readonly state: VerificationState;
  /** The state from the checks alone; differs from `state` only when the note is stale. */
  readonly checkState: CheckState;
  /** The OKF trust tier, as the spec defines it from the frontmatter. */
  readonly tier: TrustTierResult;
  /**
   * The tier from the entries Knowtarium trusts: unconfirmed `human:` entries left out. The same
   * as `tier` with `"trust-frontmatter"`. Show this one; `tier` is what a plain OKF reader sees.
   */
  readonly confirmedTier: TrustTierResult;
  readonly freshness: Freshness;
  /** The current change (`generated`), `null` when the note has none. */
  readonly change: ProvenanceEntry | null;
  /** The people's checks that count. */
  readonly humanChecks: readonly CheckAssessment[];
  /** The agents' checks that count (authorship and passing check records included). */
  readonly agentChecks: readonly CheckAssessment[];
  /** Every check looked at, counted or not: authorship, then `verified` in order, then records. */
  readonly checks: readonly CheckAssessment[];
  /** `human:` entries without a matching signed event (none with `"trust-frontmatter"`). */
  readonly unconfirmed: readonly VerifiedEntry[];
  /** Failing check records for the current version that no later check by the agent replaced. */
  readonly conflicts: readonly CheckRecordSignal[];
  /** Passing check records that count but aren't written into the note yet (to apply). */
  readonly unappliedPasses: readonly CheckRecordSignal[];
  readonly reasons: readonly VerificationReason[];
}
