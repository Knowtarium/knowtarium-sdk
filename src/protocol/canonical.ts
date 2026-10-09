/** An unpaired UTF-16 surrogate, which has no UTF-8 encoding. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The canonical text of a flat record: JSON with the keys sorted, no whitespace, string and
 * integer values only, and absent (`undefined`) fields left out. Keys and strings must be
 * well-formed Unicode (no lone surrogates). The same rules as the canonicalizer in
 * `knowtarium/crypto`; a shared vectors test keeps them identical. The signing prefix is added
 * separately (`envelopeSigningText`).
 */
export function canonicalJson(
  record: Readonly<Record<string, string | number | undefined>>,
): string {
  // callers outside TypeScript can still pass an array (whose indexes would become keys) or null
  const input: unknown = record;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("canonicalJson: expected a flat record");
  }
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) continue;
    if (LONE_SURROGATE.test(key) || (typeof value === "string" && LONE_SURROGATE.test(value))) {
      throw new TypeError(`canonicalJson: ${key} is not well-formed Unicode`);
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new TypeError(`canonicalJson: ${key} is not an integer`);
    }
    if (typeof value !== "number" && typeof value !== "string") {
      throw new TypeError(`canonicalJson: ${key} is not a string or an integer`);
    }
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}
