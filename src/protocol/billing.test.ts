import { describe, expect, it } from "vitest";

import {
  ChangePlanRequest,
  ChangePlanResponse,
  CheckoutRequest,
  CheckoutResponse,
  comparePlans,
  DEFAULT_PLAN,
  errorStatus,
  isKnownPlanId,
  offerPrice,
  Ok,
  parseErrorBody,
  PlanInfo,
  PlanOffer,
  planChangeEffect,
  PLAN_IDS,
  RevokeTokenResponse,
  routes,
  PortalSessionResponse,
  workspaceLimitReached,
} from "./index.js";
import { id } from "./test-fixtures.js";

describe("billing and revocation", () => {
  it("starts a checkout for a plan and interval on sale and answers the provider's https page", () => {
    expect(routes.startCheckout).toMatchObject({
      method: "POST",
      path: "/billing/checkout",
      auth: "session",
      body: CheckoutRequest,
    });
    for (const choice of [
      { planId: "starter", interval: "month" },
      { planId: "pro", interval: "year" },
    ]) {
      expect(CheckoutRequest.parse(choice)).toEqual(choice);
    }
    for (const bad of [
      { planId: "pro" },
      { planId: "pro", interval: "week" },
      { planId: "Pro", interval: "month" },
      { planId: "pro", interval: "month", productId: "0b6c2b1e-5f3a-4c1d-9e2f-7a8b9c0d1e2f" },
      { productId: "0b6c2b1e-5f3a-4c1d-9e2f-7a8b9c0d1e2f" },
    ]) {
      expect(CheckoutRequest.safeParse(bad).success).toBe(false);
    }
    const response = { url: "https://sandbox.polar.sh/checkout/polar_c_1" };
    expect(CheckoutResponse.parse(response)).toEqual(response);
    expect(CheckoutResponse.safeParse({ url: "http://polar.sh/checkout/1" }).success).toBe(false);
  });

  it("changes the live subscription's plan, now or at renewal, and drops a scheduled change", () => {
    expect(routes.changePlan).toMatchObject({
      method: "POST",
      path: "/billing/subscription/change",
      auth: "session",
      body: ChangePlanRequest,
      response: ChangePlanResponse,
    });
    expect(routes.cancelPlanChange).toMatchObject({
      method: "DELETE",
      path: "/billing/subscription/change",
      auth: "session",
      body: null,
      response: Ok,
    });
    expect(ChangePlanRequest.parse({ planId: "pro", interval: "year" })).toEqual({
      planId: "pro",
      interval: "year",
    });
    expect(ChangePlanRequest.safeParse({ planId: "pro", interval: "year", x: 1 }).success).toBe(
      false,
    );
    const applied = { effect: "applied", appliesAt: null };
    const scheduled = { effect: "scheduled", appliesAt: "2026-11-07T00:00:00.000Z" };
    expect(ChangePlanResponse.parse(applied)).toEqual(applied);
    expect(ChangePlanResponse.parse(scheduled)).toEqual(scheduled);
    for (const bad of [
      { effect: "scheduled", appliesAt: null },
      { effect: "applied", appliesAt: "2026-11-07T00:00:00.000Z" },
      { effect: "later", appliesAt: null },
    ]) {
      expect(ChangePlanResponse.safeParse(bad).success).toBe(false);
    }
  });

  it("refuses a change the subscription can't take (409) or couldn't pay for (402)", () => {
    expect(errorStatus("subscription_not_changeable")).toBe(409);
    expect(errorStatus("payment_failed")).toBe(402);
    for (const code of ["subscription_not_changeable", "payment_failed"]) {
      const body = { error: { code, message: "No" } };
      expect(parseErrorBody(body)).toEqual(body);
    }
  });

  it("tells the owner when a revoked token's workspace key must rotate", () => {
    expect(routes.revokeToken.response).toBe(RevokeTokenResponse);
    const rotate = { ok: true, mustRotateKey: { workspaceId: id("ws") } };
    expect(RevokeTokenResponse.parse(rotate)).toEqual(rotate);
    expect(RevokeTokenResponse.parse({ ok: true, mustRotateKey: null })).toMatchObject({
      mustRotateKey: null,
    });
    expect(RevokeTokenResponse.safeParse({ ok: true }).success).toBe(false);
  });

  it("names the plan and its usage when a limit refuses a write or a workspace", () => {
    const plan = { id: "free", storageQuotaBytes: 500 * 1024 * 1024, maxWorkspaces: 1 };
    const usage = {
      usedBytes: 10,
      quotaBytes: plan.storageQuotaBytes,
      workspaceCount: 1,
      maxWorkspaces: 1,
    };
    for (const code of ["quota_exceeded", "workspace_limit"] as const) {
      expect(errorStatus(code)).toBe(402);
      const body = { error: { code, message: "Over the plan", plan, usage } };
      expect(parseErrorBody(body)).toEqual(body);
      expect(parseErrorBody({ error: { code, message: "Over the plan", usage } })).toBeNull();
    }
  });
});

const STARTER = { id: "starter", storageQuotaBytes: 2_147_483_648, maxWorkspaces: 5 };
const PRO = { id: "pro", storageQuotaBytes: 10_737_418_240, maxWorkspaces: null };
const prices = (month: number, year: number) => [
  { amount: month, currency: "usd", interval: "month" },
  { amount: year, currency: "usd", interval: "year" },
];
const STARTER_OFFER = { ...STARTER, prices: prices(599, 5988) };
const PRO_OFFER = { ...PRO, prices: prices(1199, 11988) };
const NO_SUBSCRIPTION = {
  status: "none",
  planId: null,
  interval: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  pendingChange: null,
};

describe("plans", () => {
  it("make Free the default: 500 MB in binary units and one workspace", () => {
    expect(DEFAULT_PLAN).toEqual({ id: "free", storageQuotaBytes: 524_288_000, maxWorkspaces: 1 });
  });

  it("know Free, Starter and Pro, smallest first", () => {
    expect(PLAN_IDS).toEqual(["free", "starter", "pro"]);
    for (const id of PLAN_IDS) expect(isKnownPlanId(id)).toBe(true);
    for (const id of ["team", "PRO", "", "constructor"]) expect(isKnownPlanId(id)).toBe(false);
  });

  it("say when the workspace limit is reached, or passed after a move to a smaller plan", () => {
    const usage = { usedBytes: 0, quotaBytes: 1, workspaceCount: 0, maxWorkspaces: 1 };
    expect(workspaceLimitReached(usage)).toBe(false);
    expect(workspaceLimitReached({ ...usage, workspaceCount: 1 })).toBe(true);
    expect(workspaceLimitReached({ ...usage, workspaceCount: 3 })).toBe(true);
    expect(workspaceLimitReached({ ...usage, workspaceCount: 50, maxWorkspaces: null })).toBe(
      false,
    );
  });

  it("answer the account's plan, its subscription, every offer and the upgrades", () => {
    const info = {
      plan: DEFAULT_PLAN,
      subscription: NO_SUBSCRIPTION,
      usage: { usedBytes: 0, quotaBytes: 524_288_000, workspaceCount: 1, maxWorkspaces: 1 },
      writable: true,
      offers: [STARTER_OFFER, PRO_OFFER],
      upgradePlans: [STARTER_OFFER, PRO_OFFER],
    };
    expect(PlanInfo.parse(info)).toEqual(info);
    expect(PlanInfo.safeParse({ ...info, upgradePlans: undefined }).success).toBe(false);
    expect(PlanInfo.safeParse({ ...info, offers: undefined }).success).toBe(false);
    for (const bad of [
      [],
      [{ ...STARTER_OFFER.prices[0], currency: "USD" }],
      [{ ...STARTER_OFFER.prices[0], productId: "prod_1", interval: "week" }],
    ]) {
      expect(PlanInfo.safeParse({ ...info, offers: [{ ...STARTER, prices: bad }] }).success).toBe(
        false,
      );
    }
  });

  it("answer a paid subscription with its plan, interval and a change waiting for the renewal", () => {
    const subscription = {
      ...NO_SUBSCRIPTION,
      status: "active",
      planId: "pro",
      interval: "year",
      currentPeriodEnd: "2027-10-07T00:00:00.000Z",
      pendingChange: {
        planId: "starter",
        interval: "month",
        appliesAt: "2027-10-07T00:00:00.000Z",
      },
    };
    const info = {
      plan: PRO,
      subscription,
      usage: {
        usedBytes: 0,
        quotaBytes: PRO.storageQuotaBytes,
        workspaceCount: 7,
        maxWorkspaces: null,
      },
      writable: true,
      offers: [STARTER_OFFER, PRO_OFFER],
      upgradePlans: [],
    };
    expect(PlanInfo.parse(info)).toEqual(info);
    for (const pendingChange of [
      { planId: "starter", interval: "month" },
      { planId: "starter", interval: "month", appliesAt: null },
    ]) {
      expect(
        PlanInfo.safeParse({ ...info, subscription: { ...subscription, pendingChange } }).success,
      ).toBe(false);
    }
    expect(
      PlanInfo.safeParse({ ...info, subscription: { ...subscription, interval: "week" } }).success,
    ).toBe(false);
  });

  it("sell a plan at one price per interval, and find it by interval", () => {
    expect(PlanOffer.parse(PRO_OFFER)).toEqual(PRO_OFFER);
    expect(
      PlanOffer.parse({ ...PRO, prices: prices(1199, 11988).slice(0, 1) }).prices,
    ).toHaveLength(1);
    const twice = { ...PRO, prices: [...prices(1199, 11988), prices(1, 1)[0]] };
    expect(PlanOffer.safeParse(twice).success).toBe(false);
    const sameInterval = { ...PRO, prices: [prices(1199, 1)[0], prices(1, 1)[0]] };
    expect(PlanOffer.safeParse(sameInterval).success).toBe(false);
    const offer = PlanOffer.parse(PRO_OFFER);
    expect(offerPrice(offer, "year")).toEqual({ amount: 11988, currency: "usd", interval: "year" });
    expect(offerPrice({ ...offer, prices: offer.prices.slice(0, 1) }, "year")).toBeUndefined();
  });

  it("order plans by storage, then workspaces (unlimited the most)", () => {
    const free = DEFAULT_PLAN;
    expect(comparePlans(free, STARTER)).toBe(-1);
    expect(comparePlans(PRO, STARTER)).toBe(1);
    expect(comparePlans(PRO, PRO)).toBe(0);
    const sameStorage = { ...STARTER, maxWorkspaces: null };
    expect(comparePlans(sameStorage, STARTER)).toBe(1);
    expect(comparePlans(STARTER, sameStorage)).toBe(-1);
    expect(comparePlans(sameStorage, sameStorage)).toBe(0);
  });

  it("apply an upgrade now and anything else at the renewal", () => {
    const at = (plan: typeof STARTER | typeof PRO, interval: "month" | "year") => ({
      plan,
      interval,
    });
    // up: a larger plan, monthly to yearly, or both
    expect(planChangeEffect(at(STARTER, "month"), at(PRO, "month"))).toBe("applied");
    expect(planChangeEffect(at(STARTER, "month"), at(STARTER, "year"))).toBe("applied");
    expect(planChangeEffect(at(STARTER, "month"), at(PRO, "year"))).toBe("applied");
    expect(planChangeEffect(at(STARTER, "year"), at(PRO, "year"))).toBe("applied");
    // down: a smaller plan, yearly to monthly, or one up and the other down
    expect(planChangeEffect(at(PRO, "month"), at(STARTER, "month"))).toBe("scheduled");
    expect(planChangeEffect(at(PRO, "year"), at(PRO, "month"))).toBe("scheduled");
    expect(planChangeEffect(at(STARTER, "year"), at(PRO, "month"))).toBe("scheduled");
    expect(planChangeEffect(at(PRO, "month"), at(STARTER, "year"))).toBe("scheduled");
    // nothing changes
    expect(planChangeEffect(at(PRO, "year"), at(PRO, "year"))).toBeNull();
  });

  it("schedule a move to another plan whose limits compare equal; null only for the same plan and interval", () => {
    const renamed = { ...PRO, id: "pro-2024" };
    expect(comparePlans(renamed, PRO)).toBe(0);
    expect(
      planChangeEffect({ plan: PRO, interval: "month" }, { plan: renamed, interval: "month" }),
    ).toBe("scheduled");
    expect(
      planChangeEffect({ plan: renamed, interval: "year" }, { plan: PRO, interval: "year" }),
    ).toBe("scheduled");
    // the interval still decides when it moves
    expect(
      planChangeEffect({ plan: PRO, interval: "month" }, { plan: renamed, interval: "year" }),
    ).toBe("applied");
    expect(
      planChangeEffect({ plan: renamed, interval: "year" }, { plan: PRO, interval: "month" }),
    ).toBe("scheduled");
    expect(
      planChangeEffect({ plan: renamed, interval: "month" }, { plan: renamed, interval: "month" }),
    ).toBeNull();
  });

  it("decide every paid plan and interval pair by the rule: up on neither side down is applied", () => {
    const plans = { starter: STARTER, pro: PRO } as const;
    const choices = (["starter", "pro"] as const).flatMap((plan) =>
      (["month", "year"] as const).map((interval) => ({ plan, interval })),
    );
    const rank = { starter: 0, pro: 1, month: 0, year: 1 } as const;
    const seen: string[] = [];
    for (const from of choices) {
      for (const to of choices) {
        const planStep = rank[to.plan] - rank[from.plan];
        const intervalStep = rank[to.interval] - rank[from.interval];
        const expected =
          planStep === 0 && intervalStep === 0
            ? null
            : planStep >= 0 && intervalStep >= 0
              ? "applied"
              : "scheduled";
        const label = `${from.plan}/${from.interval} -> ${to.plan}/${to.interval}`;
        const effect = planChangeEffect(
          { plan: plans[from.plan], interval: from.interval },
          { plan: plans[to.plan], interval: to.interval },
        );
        expect(effect, label).toBe(expected);
        seen.push(`${label}: ${String(effect)}`);
      }
    }
    expect(seen).toHaveLength(16);
    expect(seen.filter((line) => line.endsWith("applied"))).toHaveLength(5);
    expect(seen.filter((line) => line.endsWith("scheduled"))).toHaveLength(7);
    expect(seen.filter((line) => line.endsWith("null"))).toHaveLength(4);
  });
});

describe("the billing portal link", () => {
  it("takes only https URLs", () => {
    expect(
      PortalSessionResponse.safeParse({ url: "https://billing.example.com/p/1" }).success,
    ).toBe(true);
    for (const url of ["http://billing.example.com/p/1", "javascript:alert(1)", "ftp://x.test"]) {
      expect(PortalSessionResponse.safeParse({ url }).success).toBe(false);
    }
  });
});
