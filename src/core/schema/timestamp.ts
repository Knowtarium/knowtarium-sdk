// OKF dates and date-times as they appear in frontmatter. With YAML 1.2 (the default) they parse
// as strings, in any of the forms YAML's timestamp type allows.
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:(?:[Tt]|[ \t]+)(\d{2}):(\d{2}):(\d{2})(\.\d+)?[ \t]*(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?)?$/;

/**
 * Parses an OKF timestamp into epoch milliseconds, or `null` when it isn't one. Accepts a date
 * (`2026-09-26`, midnight UTC) and a date-time with `T` or a space, optional fractions, and a `Z`
 * or numeric zone (none means UTC), so the three forms agents commonly write all work.
 */
export function parseOkfTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction, , sign, zoneHour, zoneMinute] =
    match.map((part) => part as string | undefined);
  const [y, mo, d] = [Number(year), Number(month), Number(day)];
  const [h, mi, s] = [Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = fraction === undefined ? 0 : Math.round(Number(fraction) * 1000);
  const offset =
    sign === undefined
      ? 0
      : (sign === "-" ? -1 : 1) * (Number(zoneHour) * 60 + Number(zoneMinute ?? 0));
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.getTime() - offset * 60_000;
}

/** Whether a string is an OKF timestamp. */
export function isOkfTimestamp(value: string): boolean {
  return parseOkfTimestamp(value) !== null;
}
