import {
  isKnownPlanId,
  type KnownPlanId,
  PLAN_IDS,
  type Plan,
  type Usage,
} from "../../protocol/index.js";

/** A refusal of a plan limit (402), as the sync API answers it. */
export interface PlanLimitRefusal {
  readonly code: "quota_exceeded" | "workspace_limit";
  readonly plan: Plan;
  readonly usage: Usage;
}

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * A size in the binary units plans are sold in ("500 MB", "1.5 GB"), as the web app shows it. One
 * decimal below 10, whole numbers above. A used amount rounds `down`, so storage a little under the
 * limit never reads as the whole limit ("499 MB" of 500 MB, not "500 MB").
 */
export function formatPlanBytes(bytes: number, rounding: "nearest" | "down" = "nearest"): string {
  const round = rounding === "down" ? Math.floor : Math.round;
  if (!Number.isFinite(bytes) || bytes < 1024) return `${String(Math.max(0, round(bytes)))} B`;
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? round(value * 10) / 10 : round(value);
  return `${String(rounded)} ${UNITS[unit] ?? "TB"}`;
}

/**
 * The names of the plans this SDK knows (`PLAN_IDS`). Any other plan id is the server's own
 * string, so it is never turned into words for an agent: the text says "your plan" instead.
 */
const KNOWN_PLAN_NAMES: Readonly<Record<KnownPlanId, string>> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
};

/** The name of a known plan id ("Free"), else undefined. */
function knownPlanName(planId: string): string | undefined {
  return isKnownPlanId(planId) ? KNOWN_PLAN_NAMES[planId] : undefined;
}

/**
 * The 402 body says nothing about what is on sale, so the upgrade is offered only conditionally,
 * and not at all on the largest plan the SDK knows (Pro).
 */
function upgradeClause(planId: string): string | null {
  return planId === PLAN_IDS.at(-1)
    ? null
    : "if a larger plan is offered, upgrade in Settings, then Plan and billing";
}

/**
 * What an agent tells the person when a plan limit refuses a change: the limit, what is used, and
 * how to get more. Built from the refusal's numbers and known plan ids only, never from the
 * server's own message or an unknown plan id, so a server can't put words in the agent's mouth.
 */
export function describePlanLimit(refusal: PlanLimitRefusal): string {
  const { plan, usage } = refusal;
  const name = knownPlanName(plan.id);
  const upgrade = upgradeClause(plan.id);
  if (refusal.code === "workspace_limit") {
    const limit = plan.maxWorkspaces ?? usage.workspaceCount;
    const allowed = `${String(limit)} ${limit === 1 ? "workspace" : "workspaces"}`;
    const subject = name === undefined ? "Your Knowtarium plan" : `The Knowtarium ${name} plan`;
    const ways = upgrade === null ? "delete a workspace" : `delete a workspace or, ${upgrade}`;
    return `${subject} allows ${allowed}, and the account has ${String(usage.workspaceCount)}. Nothing else is affected. To add one, the person can ${ways}.`;
  }
  const thePlan = name === undefined ? "your plan" : `the ${name} plan`;
  const free =
    "The person can free space by deleting files or a workspace, or by shortening a workspace's note history in its settings (older versions of notes count toward storage until the history period removes them, so deleting a note frees its space only after that period)";
  const more = upgrade === null ? "" : `. Or, ${upgrade}`;
  return `Knowtarium has no room for this change: ${thePlan} holds ${formatPlanBytes(plan.storageQuotaBytes)} and ${formatPlanBytes(usage.usedBytes, "down")} is used, so it wasn't saved. Reading still works. ${free}${more}.`;
}
