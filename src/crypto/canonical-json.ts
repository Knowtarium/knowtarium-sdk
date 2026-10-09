import { CryptoError } from "./errors.js";

// Canonical JSON: one exact text per value, so a signature made in one client verifies in every
// other. It is RFC 8785 (JSON Canonicalization Scheme) restricted to integers:
//
// 1. Values are null, true, false, strings, numbers, arrays and plain objects. Anything else
//    (undefined, functions, bigint, Date, Map, class instances, cycles) is refused.
// 2. Numbers must be safe integers (|n| <= 2^53 - 1), written in plain decimal; -0 is written 0.
//    Fractions, NaN and Infinity are refused, since float formatting differs between languages.
// 3. Strings must be well-formed Unicode (no lone surrogates). They are written as JSON.stringify
//    writes them: `"` and `\` escaped, U+0008, U+0009, U+000A, U+000C and U+000D as \b \t \n \f \r,
//    other characters below U+0020 as \u00xx (lowercase hex), everything else as is.
// 4. Object keys are sorted by UTF-16 code units (JavaScript's default string order); a property
//    whose value is undefined is refused rather than dropped.
// 5. No whitespace anywhere. The result is signed as UTF-8.

/** A JSON value canonical JSON accepts. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The canonical JSON text of `value` (rules above). Throws `non_canonical_json` if it has none. */
export function canonicalJson(value: JsonValue): string {
  return encode(value, new Set());
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null || value === true || value === false) return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) refuse("numbers must be safe integers");
    return value === 0 ? "0" : String(value);
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) refuse("strings must be well-formed Unicode");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") refuse("only JSON values have a canonical form");
  if (seen.has(value)) refuse("the value has a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      refuse("only plain objects have a canonical form");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) refuse("properties must not be undefined");
        return `${encode(key, seen)}:${encode(item, seen)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function refuse(reason: string): never {
  throw new CryptoError("non_canonical_json", `no canonical JSON: ${reason}`);
}
