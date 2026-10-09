import { FrontmatterEditError } from "./errors.js";

/**
 * Who made or checked a change, as written in `generated.by` and `verified[].by`: a person
 * (`human:<id>`), an agent (`agent:<id>`, or OKF's `<producer>/<version>` such as
 * `claude-code/2.1`) or an automated process (`process:<id>`).
 */
export type Actor =
  `human:${string}` | `agent:${string}` | `process:${string}` | `${string}/${string}`;

const PREFIXED_ACTOR = /^(?:human|agent|process):[A-Za-z0-9][\w.@+-]*$/;
const PRODUCER_ACTOR = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.+-]*$/;

/** Whether a string is an actor the edits accept (reading accepts any string). */
export function isActor(value: string): value is Actor {
  return PREFIXED_ACTOR.test(value) || PRODUCER_ACTOR.test(value);
}

export function assertActor(value: string): Actor {
  if (!isActor(value)) {
    throw new FrontmatterEditError(
      `${JSON.stringify(value)} is not an actor: use human:<id>, agent:<id>, process:<id> or <producer>/<version>`,
    );
  }
  return value;
}

const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Formats the time of an edit as an ISO 8601 date-time: a `Date` becomes UTC with seconds
 * (`2026-09-30T12:00:00Z`, milliseconds only when non-zero); a string must already be a full
 * date-time with a zone and is written as given.
 */
export function formatTimestamp(at: Date | string): string {
  if (typeof at === "string") {
    if (!UTC_DATE_TIME.test(at) || Number.isNaN(Date.parse(at))) {
      throw new FrontmatterEditError(
        `${JSON.stringify(at)} is not an ISO 8601 date-time with a time zone`,
      );
    }
    return at;
  }
  if (Number.isNaN(at.getTime())) throw new FrontmatterEditError("The date is invalid");
  return at.toISOString().replace(".000Z", "Z");
}
