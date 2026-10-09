import { type Provenance, readProvenance, type VerifiedEntry } from "./provenance.js";

/**
 * OKF's trust tiers (§5.3), derived from `verified` and never declared:
 *
 * - `unverified`: no `verified` entries at all
 * - `machine-confirmed`: verified only by agents or processes
 * - `human-reviewed`: verified by at least one person (`human:<id>`)
 *
 * Staleness is separate (see `freshness`). Knowtarium's own states (`verification`) are stricter
 * and never contradict the tier: `fully-verified` and `agent-check-pending` need a person's check,
 * so those notes are always `human-reviewed`.
 */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export interface TrustTierResult {
  readonly tier: TrustTier;
  /**
   * The entries that decided the tier: the people's entries for `human-reviewed`, the machines'
   * entries for `machine-confirmed`, none for `unverified`.
   */
  readonly counted: readonly VerifiedEntry[];
}

/** The trust tier of already read provenance. */
export function trustTierOf(provenance: Provenance): TrustTierResult {
  const humans = provenance.verified.filter((entry) => entry.kind === "human");
  if (humans.length > 0) return { tier: "human-reviewed", counted: humans };
  if (provenance.verified.length > 0) {
    return { tier: "machine-confirmed", counted: provenance.verified };
  }
  return { tier: "unverified", counted: [] };
}

/**
 * The OKF trust tier of a note, from its frontmatter values. As in the spec, every `verified`
 * entry that names an actor counts, whatever its date: the tier says who has checked the note,
 * not whether the check is current (that is what `deriveVerification` adds).
 */
export function deriveTrustTier(frontmatter: Readonly<Record<string, unknown>>): TrustTierResult {
  return trustTierOf(readProvenance(frontmatter));
}
