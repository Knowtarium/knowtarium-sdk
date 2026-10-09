import { describe, expect, it } from "vitest";

import { ERROR_CODES, ERROR_STATUS, ErrorBody, errorStatus, parseErrorBody } from "./index.js";

describe("errors", () => {
  it("gives every code an error status", () => {
    for (const code of ERROR_CODES) {
      expect(errorStatus(code)).toBeGreaterThanOrEqual(400);
      expect(errorStatus(code)).toBeLessThan(600);
    }
  });

  it("uses the agreed statuses for the codes clients branch on", () => {
    expect(ERROR_STATUS.conflict).toBe(409);
    expect(ERROR_STATUS.quota_exceeded).toBe(402);
    expect(ERROR_STATUS.scope_denied).toBe(403);
    expect(ERROR_STATUS.rate_limited).toBe(429);
    // an agent's direct write: propose instead, or refetch the policy
    expect(ERROR_STATUS.approval_required).toBe(403);
    expect(ERROR_STATUS.agent_key_required).toBe(403);
    expect(ERROR_STATUS.stale_agent_policy).toBe(409);
    for (const code of ["approval_required", "agent_key_required", "stale_agent_policy"]) {
      expect(ErrorBody.safeParse({ error: { code, message: "x" } }).success, code).toBe(true);
    }
  });

  it("carries the current version on a conflict", () => {
    const body = { error: { code: "conflict", message: "Stale base version", currentVersion: 7 } };
    expect(parseErrorBody(body)).toEqual(body);
    expect(ErrorBody.safeParse({ error: { code: "conflict", message: "x" } }).success).toBe(false);
  });

  it("carries the plan and its usage when the quota is exceeded", () => {
    const body = {
      error: {
        code: "quota_exceeded",
        message: "Storage is full",
        plan: { id: "free", storageQuotaBytes: 10, maxWorkspaces: 1 },
        usage: { usedBytes: 10, quotaBytes: 10, workspaceCount: 1, maxWorkspaces: 1 },
      },
    };
    expect(ErrorBody.safeParse(body).success).toBe(true);
  });

  it("accepts plain codes and refuses unknown ones", () => {
    expect(ErrorBody.safeParse({ error: { code: "scope_denied", message: "x" } }).success).toBe(
      true,
    );
    expect(ErrorBody.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
    expect(parseErrorBody("nope")).toBeNull();
  });

  it("points at the invalid fields", () => {
    const body = {
      error: {
        code: "invalid_request",
        message: "Invalid body",
        issues: [{ at: ["body", "folderIds", 0], problem: "Expected a fld_ id" }],
      },
    };
    expect(ErrorBody.safeParse(body).success).toBe(true);
  });
});
