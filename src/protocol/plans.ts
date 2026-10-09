import { z } from "zod";

import { defineRoute } from "./route.js";
import { Ok, SizeBytes, Timestamp } from "./primitives.js";

/**
 * A plan id from the sync API's plan table: `free`, `starter` or `pro` today (`PLAN_IDS`). The
 * schema takes any well-formed id, so a client keeps reading the plan page when the server adds a
 * plan; only the ids in `PLAN_IDS` are ever named in a client's own words.
 */
export const PlanId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, { error: "Expected a plan id" });
export type PlanId = z.infer<typeof PlanId>;

/** The plans this SDK knows, smallest first: Free, Starter (paid), Pro (paid, the largest). */
export const PLAN_IDS = ["free", "starter", "pro"] as const;
export type KnownPlanId = (typeof PLAN_IDS)[number];

/** Whether a plan id is one this SDK knows (`PLAN_IDS`). */
export function isKnownPlanId(planId: string): planId is KnownPlanId {
  return (PLAN_IDS as readonly string[]).includes(planId);
}

/**
 * How often a paid plan renews: every month, or every year (sold at a lower monthly price). Each
 * plan and interval is its own product of the payment provider (Polar), so the sync API resolves
 * the product from the plan and interval; clients never see product ids.
 */
export const BillingInterval = z.enum(["month", "year"]);
export type BillingInterval = z.infer<typeof BillingInterval>;

/** A row of the plan table. `maxWorkspaces` null means unlimited. */
export const Plan = z.object({
  id: PlanId,
  storageQuotaBytes: SizeBytes,
  maxWorkspaces: z.int().positive().nullable(),
});
export type Plan = z.infer<typeof Plan>;

/**
 * The plan every account is on unless something grants another: Free, 500 MB and one workspace
 * (Starter holds 2 GB and five workspaces, Pro 10 GB and any number; the sync API's plan table
 * has those rows, and the plan page answers them in `offers`).
 * Sizes count in binary units, as every Knowtarium client shows them (1 MB is 1,048,576 bytes), so
 * 500 MB is 524,288,000 bytes. The sync API seeds the same row in its plan table.
 */
export const DEFAULT_PLAN: Plan = {
  id: "free",
  storageQuotaBytes: 500 * 1024 * 1024,
  maxWorkspaces: 1,
};

/**
 * The state of the account's subscription, if any. `past_due` keeps the paid plan for a grace
 * period (`graceEndsAt`); `paused` and `canceled` grant nothing (the account is on Free).
 */
export const SubscriptionStatus = z.enum([
  "none",
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** Storage used is the sum of every stored ciphertext: versions, pending changes, records, files. */
export const Usage = z.object({
  usedBytes: SizeBytes,
  quotaBytes: SizeBytes,
  workspaceCount: z.int().nonnegative(),
  maxWorkspaces: z.int().positive().nullable(),
});
export type Usage = z.infer<typeof Usage>;

/**
 * Whether the account can't create another workspace: it owns as many as its plan allows, or more
 * (an account keeps every workspace when it moves to a smaller plan).
 */
export function workspaceLimitReached(usage: Usage): boolean {
  return usage.maxWorkspaces !== null && usage.workspaceCount >= usage.maxWorkspaces;
}

/**
 * A product id of the payment provider (Polar), as the sync API's product mapping names it:
 * letters, digits, `-` and `_` (Polar's are UUIDs). Server side only: no request or response of
 * the API carries one (a checkout or a plan change names the plan and the interval).
 */
export const ProductId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, { error: "Expected a product id" });
export type ProductId = z.infer<typeof ProductId>;

/** An ISO 4217 currency code in lowercase, as Polar writes it (`usd`). */
export const CurrencyCode = z.string().regex(/^[a-z]{3}$/, { error: "Expected a currency code" });
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * The price a plan is sold at for one interval, in the currency's smallest unit, charged once per
 * interval: Starter is 599 a month or 5988 a year ($5.99, or $59.88 shown as "$4.99/mo billed
 * yearly"), Pro 1199 or 11988. The sync API takes it from its product mapping, so the amount shown
 * is set per environment next to the product it describes; the checkout shows the price charged.
 */
export const PlanPrice = z.object({
  amount: z.int().nonnegative(),
  currency: CurrencyCode,
  interval: BillingInterval,
});
export type PlanPrice = z.infer<typeof PlanPrice>;

/**
 * A plan on sale with its prices, at most one per interval (monthly and yearly when both are on
 * sale), monthly first.
 */
export const PlanOffer = Plan.extend({
  prices: z
    .array(PlanPrice)
    .min(1)
    .max(BillingInterval.options.length)
    .refine((prices) => new Set(prices.map((price) => price.interval)).size === prices.length, {
      error: "Expected one price per interval",
    }),
});
export type PlanOffer = z.infer<typeof PlanOffer>;

/** The price of an offer for one interval, if it is sold that way. */
export function offerPrice(offer: PlanOffer, interval: BillingInterval): PlanPrice | undefined {
  return offer.prices.find((price) => price.interval === interval);
}

/** A plan and how often it renews: what a checkout buys and what a plan change moves to. */
export const PlanChoice = z.strictObject({ planId: PlanId, interval: BillingInterval });
export type PlanChoice = z.infer<typeof PlanChoice>;

/**
 * Orders plans by what they give: storage first, then workspaces (null, unlimited, is the most).
 * Negative when `a` gives less than `b`, 0 when they give the same. The sync API orders plans the
 * same way (Free < Starter < Pro).
 */
export function comparePlans(
  a: Pick<Plan, "storageQuotaBytes" | "maxWorkspaces">,
  b: Pick<Plan, "storageQuotaBytes" | "maxWorkspaces">,
): number {
  const workspaces = (plan: Pick<Plan, "maxWorkspaces">) =>
    plan.maxWorkspaces ?? Number.POSITIVE_INFINITY;
  const storage = a.storageQuotaBytes - b.storageQuotaBytes;
  if (storage !== 0) return Math.sign(storage);
  const count = workspaces(a) - workspaces(b);
  return Number.isNaN(count) ? 0 : Math.sign(count);
}

/**
 * When a plan change takes effect: `applied` at once for an upgrade (neither the plan nor the
 * interval goes down, and the plan gives more or the interval gets longer: Starter to Pro, monthly
 * to yearly, Starter monthly to Pro yearly), the difference charged now; `scheduled` at renewal for
 * anything else (a smaller plan, yearly to monthly, one up and the other down, or another plan
 * whose limits compare equal at the same interval, such as a renamed plan), with no refund or
 * credit. Null only for the identical plan (same id) and interval. The sync API decides with the
 * same rule; clients use it to say what a change will do before asking for it.
 */
export function planChangeEffect(
  from: {
    readonly plan: Pick<Plan, "id" | "storageQuotaBytes" | "maxWorkspaces">;
    readonly interval: BillingInterval;
  },
  to: {
    readonly plan: Pick<Plan, "id" | "storageQuotaBytes" | "maxWorkspaces">;
    readonly interval: BillingInterval;
  },
): "applied" | "scheduled" | null {
  if (from.plan.id === to.plan.id && from.interval === to.interval) return null;
  const plan = comparePlans(to.plan, from.plan);
  const rank = (interval: BillingInterval) => BillingInterval.options.indexOf(interval);
  const interval = Math.sign(rank(to.interval) - rank(from.interval));
  if (plan === 0 && interval === 0) return "scheduled";
  return plan >= 0 && interval >= 0 ? "applied" : "scheduled";
}

/**
 * A plan change waiting for the subscription's renewal (a downgrade, or a move to monthly): at
 * `appliesAt` the subscription moves to this plan and interval. `cancelPlanChange` drops it.
 */
export const PendingPlanChange = z.object({
  planId: PlanId,
  interval: BillingInterval,
  appliesAt: Timestamp,
});
export type PendingPlanChange = z.infer<typeof PendingPlanChange>;

/**
 * The account's subscription, if any. `planId` and `interval` are what it is billed as (null
 * without a subscription, or for a product the sync API doesn't map); the plan it grants is
 * `PlanInfo.plan`.
 */
export const SubscriptionInfo = z.object({
  status: SubscriptionStatus,
  planId: PlanId.nullable(),
  interval: BillingInterval.nullable(),
  currentPeriodEnd: Timestamp.nullable(),
  /** True when the subscription ends at `currentPeriodEnd` instead of renewing. */
  cancelAtPeriodEnd: z.boolean(),
  /** While `past_due`, the paid plan stays until this time; then the account is on Free. */
  graceEndsAt: Timestamp.nullable(),
  /** A downgrade or a move to monthly that waits for the renewal; null when none is scheduled. */
  pendingChange: PendingPlanChange.nullable(),
});
export type SubscriptionInfo = z.infer<typeof SubscriptionInfo>;

/**
 * The account's plan and where it stands. The plan comes from a subscription that grants access, a
 * live entitlement, the account's assigned plan, or else Free (`DEFAULT_PLAN`). Over a limit,
 * nothing is deleted: writes that add data (over the storage) or new workspaces (at the workspace
 * limit) are refused until the account is back under, and reads, export and deletes never stop.
 */
export const PlanInfo = z.object({
  plan: Plan,
  subscription: SubscriptionInfo,
  usage: Usage,
  /** False when the storage is full, so writes that add data are refused. Reads never stop. */
  writable: z.boolean(),
  /**
   * Every plan on sale, smallest first, each with its monthly and yearly prices, whatever the
   * account's subscription (the plan picker shows them all; the account's own plan among them).
   * Empty when nothing is on sale (checkout not configured).
   */
  offers: z.array(PlanOffer),
  /**
   * The plans on sale that give more than the account's own, smallest first (empty: none on sale).
   * Listed also while a subscription is live: with one, an upgrade is a plan change
   * (`changePlan`), without one a checkout (`startCheckout`).
   */
  upgradePlans: z.array(PlanOffer),
});
export type PlanInfo = z.infer<typeof PlanInfo>;

export const ListPlansResponse = z.object({ plans: z.array(Plan) });
export type ListPlansResponse = z.infer<typeof ListPlansResponse>;

/** A page of the payment provider's, made for this account (no content of the account's): https only. */
export const BillingUrl = z.url({ protocol: /^https$/, error: "Expected an https URL" });

/**
 * A plan and interval from `PlanInfo.offers` to buy; the sync API checks out the product it maps
 * to them. Only without a live subscription: with one, change it (`ChangePlanRequest`).
 */
export const CheckoutRequest = PlanChoice;
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/**
 * The payment provider's hosted checkout for the signed-in account (one session, made by the sync
 * API with its own token, bound to the account there). The web app sends the person to `url`.
 */
export const CheckoutResponse = z.object({ url: BillingUrl });
export type CheckoutResponse = z.infer<typeof CheckoutResponse>;

/**
 * A billing portal link for the signed-in account (the payment provider's page for invoices,
 * payment method and cancelling). 404 `not_found` when the account has no subscription, 503
 * `unavailable` when the provider can't be reached.
 */
export const PortalSessionResponse = z.object({ url: BillingUrl });
export type PortalSessionResponse = z.infer<typeof PortalSessionResponse>;

/**
 * Moves the live subscription to another plan or interval from `PlanInfo.offers`. An upgrade (see
 * `planChangeEffect`) applies at once and charges the difference now; anything else waits for the
 * renewal (`PlanInfo.subscription.pendingChange`). A new change replaces a scheduled one, and
 * choosing the current plan and interval while a change is scheduled just drops it (answered as
 * `applied`: the subscription stays as it is now, nothing scheduled).
 *
 * Refusals, in order: 503 `unavailable` when billing isn't configured; 403 `forbidden` while the
 * account is being deleted; 404 `not_found` without a live subscription (start a checkout
 * instead); 409 `subscription_not_changeable` while the subscription is paused, past due or
 * unpaid, or ends at the period's end (resume it in the billing portal first); 409
 * `already_exists` for the current plan and interval with no change scheduled; 404 `not_found`
 * for a plan or interval not on sale; 429 `rate_limited`; 503 `unavailable` while the payment
 * provider is busy with the subscription or can't be reached; 402 `payment_failed` when the
 * difference couldn't be charged (nothing changed; the billing portal fixes the payment method or
 * completes an authentication the bank asks for).
 */
export const ChangePlanRequest = PlanChoice;
export type ChangePlanRequest = z.infer<typeof ChangePlanRequest>;

/**
 * What a plan change did: `applied` (the subscription is on the new plan now, `appliesAt` null) or
 * `scheduled` (it moves at the renewal, `appliesAt`). Read `getAccountPlan` again for the new
 * state; payment webhooks confirm it later.
 */
export const ChangePlanResponse = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("applied"), appliesAt: z.null() }),
  z.object({ effect: z.literal("scheduled"), appliesAt: Timestamp }),
]);
export type ChangePlanResponse = z.infer<typeof ChangePlanResponse>;

export const planRoutes = {
  listPlans: defineRoute({
    method: "GET",
    path: "/plans",
    auth: "none",
    summary: "The plan table",
    response: ListPlansResponse,
  }),
  getAccountPlan: defineRoute({
    method: "GET",
    path: "/account/plan",
    auth: "session",
    summary: "The account's plan, subscription state, storage and workspaces used, and upgrades",
    response: PlanInfo,
  }),
  createPortalSession: defineRoute({
    method: "POST",
    path: "/billing/portal-sessions",
    auth: "session",
    summary: "A link to the billing portal for the account's subscription",
    response: PortalSessionResponse,
  }),
  startCheckout: defineRoute({
    method: "POST",
    path: "/billing/checkout",
    auth: "session",
    summary: "A checkout session for a plan on sale, bound to the signed-in account",
    body: CheckoutRequest,
    response: CheckoutResponse,
  }),
  changePlan: defineRoute({
    method: "POST",
    path: "/billing/subscription/change",
    auth: "session",
    summary:
      "Move the live subscription to another plan or interval: upgrades now, the rest at renewal",
    body: ChangePlanRequest,
    response: ChangePlanResponse,
  }),
  /**
   * Answers ok also when no change is scheduled; 404 `not_found` without a live subscription, 503
   * `unavailable` when billing isn't configured or the payment provider can't be reached.
   */
  cancelPlanChange: defineRoute({
    method: "DELETE",
    path: "/billing/subscription/change",
    auth: "session",
    summary: "Drop the plan change scheduled for the renewal, if any",
    response: Ok,
  }),
};
