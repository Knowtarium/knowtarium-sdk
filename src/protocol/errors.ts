import { z } from "zod";

import { Plan, Usage } from "./plans.js";
import { Version } from "./primitives.js";

/**
 * Every error the sync API returns, with its HTTP status. Codes are stable: clients branch on
 * `code`, never on `message`.
 */
export const ERROR_STATUS = {
  /** The body, query, params or headers failed their schema (`issues` says where). */
  invalid_request: 400,
  /** The `Knowtarium-Protocol-Version` header is missing or names a version the API no longer accepts. */
  unsupported_protocol: 400,
  /** A person's write, event or comment arrived without its signature. */
  signature_required: 400,
  /** The signature doesn't verify for the envelope the request implies, or `signedAt` is off. */
  invalid_signature: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  token_revoked: 401,
  /**
   * A write would add data over the plan's storage; `plan` and `usage` say how much it allows and
   * how much is used. Deleting data, or a larger plan, lets it through. Reads and export never stop.
   */
  quota_exceeded: 402,
  /**
   * A new workspace would go over the plan's workspace limit; `plan` and `usage` say the limit and
   * how many the account has. Deleting a workspace frees its slot.
   */
  workspace_limit: 402,
  /**
   * A plan change couldn't charge the difference (the card was declined, or the bank asks for an
   * authentication only the billing portal can complete). Nothing changed.
   */
  payment_failed: 402,
  /**
   * Not allowed for this caller: an agent on a session route, signing fields from an agent, or a
   * state-changing request without `Knowtarium-Request: 1`.
   */
  forbidden: 403,
  /** An agent token touched a workspace or folder outside its scope, or wrote with read access. */
  scope_denied: 403,
  /**
   * An agent's direct write (`writeNoteAsAgent`) to a folder whose agent policy is `review`
   * ("ask me first"): propose it instead (`submitPending`).
   */
  approval_required: 403,
  /**
   * An agent's direct write from a token with no signing key the owner vouched for (connected
   * before protocol 2): propose instead, or reconnect the agent.
   */
  agent_key_required: 403,
  email_not_verified: 403,
  not_found: 404,
  /**
   * The base version (or comment revision, or agent policy revision for `setAgentPolicy`) is no
   * longer current; `currentVersion` says what is.
   */
  conflict: 409,
  already_exists: 409,
  /** The ciphertext or wrapped key uses an old key generation; fetch the keys and retry. */
  stale_key_generation: 409,
  /**
   * An agent's direct write named an agent policy revision that is no longer current: fetch the
   * policy (`getAgentPolicy`), check the mode again and retry.
   */
  stale_agent_policy: 409,
  /** The pending change was already approved or rejected. */
  pending_closed: 409,
  /** A folder that still holds folders or notes can't be deleted. */
  not_empty: 409,
  /**
   * The subscription can't change plan now: it is paused, past due or unpaid, or ends at the
   * period's end. Resume it or fix the payment in the billing portal first.
   */
  subscription_not_changeable: 409,
  /**
   * The connect request, grant or email link expired; or a note version's content was removed
   * after the workspace's history period (`getVersion` on a pruned version).
   */
  expired: 410,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

/** The HTTP status for an error code. */
export function errorStatus(code: ErrorCode): (typeof ERROR_STATUS)[ErrorCode] {
  return ERROR_STATUS[code];
}

/** A short English explanation written by the server; it never contains user content. */
export const ErrorMessage = z.string().max(500);
const message = ErrorMessage;

/** One step of the path to an invalid value: a schema key or an array index. */
export const IssuePathKey = z.string().max(100);
export const IssuePathSegment = z.union([IssuePathKey, z.int()]);

const ConflictError = z.object({
  code: z.literal("conflict"),
  message,
  currentVersion: Version,
});

// Both refusals of a plan limit carry the account's plan and its usage, so a client can say what
// the limit is without asking again.
const QuotaExceededError = z.object({
  code: z.literal("quota_exceeded"),
  message,
  plan: Plan,
  usage: Usage,
});

const WorkspaceLimitError = z.object({
  code: z.literal("workspace_limit"),
  message,
  plan: Plan,
  usage: Usage,
});

/** Also sent as the `Retry-After` header. */
const RateLimitedError = z.object({
  code: z.literal("rate_limited"),
  message,
  retryAfterSeconds: z.int().nonnegative(),
});

const UnsupportedProtocolError = z.object({
  code: z.literal("unsupported_protocol"),
  message,
  supportedVersions: z.array(z.int().positive()),
});

const InvalidRequestError = z.object({
  code: z.literal("invalid_request"),
  message,
  issues: z.array(
    z.object({
      /** Where the problem is, for example `["body", "encName"]`. */
      at: z.array(IssuePathSegment),
      problem: message,
    }),
  ),
});

const detailedCodes = [
  "conflict",
  "quota_exceeded",
  "workspace_limit",
  "rate_limited",
  "unsupported_protocol",
  "invalid_request",
] as const;

type PlainCode = Exclude<ErrorCode, (typeof detailedCodes)[number]>;

const plainCodes = ERROR_CODES.filter(
  (code): code is PlainCode => !(detailedCodes as readonly string[]).includes(code),
) as [PlainCode, ...PlainCode[]];

const PlainError = z.object({ code: z.enum(plainCodes), message });

export const ApiError = z.discriminatedUnion("code", [
  ConflictError,
  QuotaExceededError,
  WorkspaceLimitError,
  RateLimitedError,
  UnsupportedProtocolError,
  InvalidRequestError,
  PlainError,
]);
export type ApiError = z.infer<typeof ApiError>;

/** The body of every error response: `{ "error": { "code": "conflict", ... } }`. */
export const ErrorBody = z.object({ error: ApiError });
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Parses an error response body; null when it isn't one. */
export function parseErrorBody(value: unknown): ErrorBody | null {
  const result = ErrorBody.safeParse(value);
  return result.success ? result.data : null;
}
