// The explanation of a verification state, as lines the web app can show: first what decides the
// state (stale, a conflict, the missing check), then the checks that count, then notes on the rest.
import type { CheckAssessment, VerificationReason, VerificationResult } from "./types.js";

type Derived = Omit<VerificationResult, "reasons">;

const when = (at: string | null): string => (at === null ? "at an unknown time" : `at ${at}`);

function changeText(result: Derived): string {
  const change = result.change;
  return change === null ? "" : ` since the change by ${change.by} ${when(change.at)}`;
}

function checkReason(check: CheckAssessment): VerificationReason {
  const base = { by: check.by, at: check.at };
  if (check.source === "authorship") {
    return {
      ...base,
      code: "agent-authored",
      message: `Written by ${check.by}, which counts as its agent check.`,
    };
  }
  if (check.source === "check-record") {
    return {
      ...base,
      code: "agent-check-unapplied",
      message: `${check.by} passed its check ${when(check.at)}; it isn't written into the note yet.`,
    };
  }
  return {
    ...base,
    code: check.kind === "human" ? "human-check" : "agent-check",
    message: `Checked by ${check.by} ${when(check.at)}.`,
  };
}

export function explain(result: Derived): VerificationReason[] {
  const decisive: VerificationReason[] = [];
  const notes: VerificationReason[] = [];

  if (result.freshness.status === "stale") {
    decisive.push({
      code: "stale",
      message: `Past its stale_after date (${result.freshness.staleAfter ?? ""}), whatever the checks say.`,
      at: result.freshness.staleAfter,
    });
  }
  for (const check of result.checks) {
    if (check.status !== "failed") continue;
    const version = check.record === undefined ? "" : ` of version ${String(check.record.version)}`;
    decisive.push({
      code: "conflict",
      message: `${check.by}'s check${version} found a conflict ${when(check.at)}.`,
      by: check.by,
      at: check.at,
    });
  }
  if (result.humanChecks.length === 0) {
    decisive.push({
      code: "no-human-check",
      message: `No person has checked it${changeText(result)}.`,
    });
  } else if (result.agentChecks.length === 0) {
    decisive.push({
      code: "no-agent-check",
      message: `No agent has checked it${changeText(result)}.`,
    });
  }

  const counted = [...result.humanChecks, ...result.agentChecks].map(checkReason);

  if (result.change === null) {
    notes.push({
      code: "no-change-recorded",
      message: "The note has no `generated` entry, so every dated check counts.",
    });
  } else if (result.change.time === null) {
    notes.push({
      code: "change-date-unknown",
      message: "`generated.at` is missing or not a date, so no check can be matched to the change.",
      by: result.change.by,
      at: result.change.at,
    });
  }
  let outdated = 0;
  for (const check of result.checks) {
    if (check.status === "before-change") outdated++;
    if (check.status === "unconfirmed") {
      notes.push({
        code: "unconfirmed-human-check",
        message: `${check.by}'s check ${when(check.at)} has no signed event, so it doesn't count.`,
        by: check.by,
        at: check.at,
      });
    }
    if (check.status === "invalid-date") {
      notes.push({
        code: "invalid-date",
        message: `A check by ${check.by} has no valid date, so it doesn't count.`,
        by: check.by,
        at: check.at,
      });
    }
  }
  if (outdated > 0) {
    notes.push({
      code: "outdated-checks",
      message:
        outdated === 1
          ? "1 check predates the change and no longer counts."
          : `${String(outdated)} checks predate the change and no longer count.`,
    });
  }
  return [...decisive, ...counted, ...notes];
}
