import { freshnessOf } from "../freshness/freshness.js";
import { type Provenance, readProvenance, type VerifiedEntry } from "../trust/provenance.js";
import { trustTierOf } from "../trust/tier.js";
import { explain } from "./reasons.js";
import {
  assessRecords,
  type ChangeMatcher,
  changeMatcher,
  confirmedKeys,
  latestPerAgent,
  verifiedEntryKey,
} from "./signals.js";
import type {
  CheckAssessment,
  CheckState,
  CheckStatus,
  VerificationOptions,
  VerificationResult,
  VerificationState,
} from "./types.js";

/** An agent's own change counts as its check (an approved agent change is fully verified). */
function authorshipCheck(provenance: Provenance): CheckAssessment[] {
  const change = provenance.generated;
  if (change?.kind !== "agent") return [];
  return [{ source: "authorship", ...change, status: "counted" }];
}

function frontmatterChecks(
  entries: readonly VerifiedEntry[],
  matchChange: ChangeMatcher,
  isConfirmed: (entry: VerifiedEntry) => boolean,
): CheckAssessment[] {
  return entries.map((entry) => {
    const { index, ...fields } = entry;
    let status: CheckStatus = matchChange(entry.time);
    if (status === "counted" && entry.kind === "human" && !isConfirmed(entry)) {
      status = "unconfirmed";
    }
    return { source: "frontmatter", ...fields, index, status };
  });
}

/**
 * Derives a note's verification state from its frontmatter values plus the signals from outside
 * it: the signed events that confirm `human:` entries (a required choice, see
 * `VerificationSignals`) and unapplied check records. Pure: no clock of its own (pass `now`), no
 * storage, no network. Never throws for malformed frontmatter.
 *
 * The rules: the change is `generated`; a check counts only when its `at` is at or after
 * `generated.at` (equal counts); `human:` actors are people, every other actor is an agent; an
 * agent's own change counts as its check; each agent's latest check stands, and a failing one is a
 * conflict; past `stale_after` the note is stale whatever the checks say.
 */
export function deriveVerification(
  frontmatter: Readonly<Record<string, unknown>>,
  options: VerificationOptions,
): VerificationResult {
  const provenance = readProvenance(frontmatter);
  const freshness = freshnessOf(frontmatter, options);
  const matchChange = changeMatcher(provenance.generated);
  const confirmed = confirmedKeys(options);
  const isConfirmed = (entry: VerifiedEntry) =>
    confirmed === null || confirmed.has(verifiedEntryKey(entry.by, entry.at));

  const checks = latestPerAgent([
    ...authorshipCheck(provenance),
    ...frontmatterChecks(provenance.verified, matchChange, isConfirmed),
    ...assessRecords(options.checks ?? [], options.note, matchChange),
  ]);
  const counted = checks.filter((check) => check.status === "counted");
  const humanChecks = counted.filter((check) => check.kind === "human");
  const agentChecks = counted.filter((check) => check.kind === "agent");
  const conflicts = checks.flatMap((check) =>
    check.status === "failed" && check.record !== undefined ? [check.record] : [],
  );
  const unappliedPasses = agentChecks.flatMap((check) =>
    check.record === undefined ? [] : [check.record],
  );
  const unconfirmed = provenance.verified.filter(
    (entry) => entry.kind === "human" && !isConfirmed(entry),
  );

  const checkState: CheckState =
    conflicts.length > 0
      ? "conflict"
      : humanChecks.length === 0
        ? "waiting-for-human"
        : agentChecks.length === 0
          ? "agent-check-pending"
          : "fully-verified";
  const state: VerificationState = freshness.status === "stale" ? "stale" : checkState;

  const result: Omit<VerificationResult, "reasons"> = {
    state,
    checkState,
    tier: trustTierOf(provenance),
    confirmedTier: trustTierOf({
      ...provenance,
      verified: provenance.verified.filter((entry) => entry.kind !== "human" || isConfirmed(entry)),
    }),
    freshness,
    change: provenance.generated,
    humanChecks,
    agentChecks,
    checks,
    unconfirmed,
    conflicts,
    unappliedPasses,
  };
  return { ...result, reasons: explain(result) };
}
