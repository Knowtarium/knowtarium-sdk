import { OKF_SPEC_VERSION } from "../spec.js";
import { type OkfFields, type OkfFieldSchemas, okfFieldsV0_2 } from "./fields.js";

/** The OKF spec versions the schemas cover, and the fields checked for each. */
export const OKF_FIELD_SCHEMAS = { "0.2": okfFieldsV0_2 } as const satisfies Record<
  string,
  OkfFieldSchemas
>;

export type OkfSpecVersion = keyof typeof OKF_FIELD_SCHEMAS;

/** The fields the app reads, in the order the schema checks them. */
export const OKF_FIELDS = Object.keys(okfFieldsV0_2) as (keyof OkfFieldSchemas)[];

/** A field whose value has the wrong shape. The value stays in the note untouched. */
export interface FieldProblem {
  /** The field, with a dotted path inside it (`verified.1.at`). */
  readonly field: string;
  readonly message: string;
}

export interface FrontmatterValidation {
  readonly version: OkfSpecVersion;
  /** The valid OKF fields, typed. Invalid or absent fields are left out. */
  readonly fields: OkfFields;
  readonly problems: readonly FieldProblem[];
}

/**
 * Checks the OKF fields of a frontmatter object, field by field. Unknown keys are allowed and
 * missing fields are fine; a field set to `null` counts as missing. Nothing is stripped or
 * rewritten: this only reports, and gives typed access to the fields that are valid.
 */
export function validateFrontmatter(
  data: Readonly<Record<string, unknown>>,
  version: OkfSpecVersion = OKF_SPEC_VERSION,
): FrontmatterValidation {
  const schemas = OKF_FIELD_SCHEMAS[version];
  const fields: Record<string, unknown> = {};
  const problems: FieldProblem[] = [];
  for (const [field, schema] of Object.entries(schemas)) {
    if (!Object.hasOwn(data, field) || data[field] === null || data[field] === undefined) continue;
    const result = schema.safeParse(data[field]);
    if (result.success) {
      fields[field] = result.data;
      continue;
    }
    for (const issue of result.error.issues) {
      problems.push({
        field: [field, ...issue.path.map(String)].join("."),
        message: issue.message,
      });
    }
  }
  return { version, fields, problems };
}
