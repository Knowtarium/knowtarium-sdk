import { parse, type Scalar } from "yaml";

/** A value the edits write as a single YAML scalar. */
export type ScalarValue = string | number | boolean;

const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
const FLOW_INDICATOR = /[,[\]{}]/;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;

function isPlainSafe(value: string, flow: boolean): boolean {
  if (value === "" || INDICATOR_START.test(value)) return false;
  if (/^\s|\s$/.test(value) || /[\n\r\t]/.test(value) || /\p{Cc}/u.test(value)) return false;
  if (value.includes(": ") || value.includes(" #") || value.endsWith(":")) return false;
  if (flow && FLOW_INDICATOR.test(value)) return false;
  try {
    // "true", "null", "1.0" and the like would read back as something other than this string
    return parse(value, { logLevel: "silent" }) === value;
  } catch {
    return false;
  }
}

function singleQuoted(value: string): string | null {
  return WHITESPACE_OR_CONTROL.test(value.replace(/ /g, ""))
    ? null
    : `'${value.replace(/'/g, "''")}'`;
}

function doubleQuoted(value: string): string {
  // JSON string escapes are all valid YAML double-quoted escapes
  return JSON.stringify(value);
}

/**
 * Renders a value as YAML scalar text. Keeps the quoting style of the node it replaces when it can
 * (single and double quotes), writes plain text when that reads back as the same string, and falls
 * back to double quotes otherwise. `flow` means the scalar sits inside `{ }` or `[ ]`.
 */
export function renderScalar(
  value: ScalarValue,
  options: { readonly style?: Scalar.Type | undefined; readonly flow?: boolean } = {},
): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`Can't write ${String(value)} to YAML`);
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (options.style === "QUOTE_DOUBLE") return doubleQuoted(value);
  if (options.style === "QUOTE_SINGLE") return singleQuoted(value) ?? doubleQuoted(value);
  return isPlainSafe(value, options.flow ?? false) ? value : doubleQuoted(value);
}
