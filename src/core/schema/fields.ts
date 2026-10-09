// zod schemas for the OKF fields the app reads, per spec version. They check shapes only: every
// object schema is loose (unknown keys pass through) and nothing is ever written from their output.
import { z } from "zod";

import { isOkfTimestamp } from "./timestamp.js";

/** Text fields also accept numbers and booleans (`title: 2024`), read as their string form. */
const text = z.union([z.string(), z.number().transform(String), z.boolean().transform(String)]);

/** A date or date-time. `%YAML 1.1` documents can yield `Date` objects, read as ISO strings. */
const timestamp = z.union([
  z.string().refine(isOkfTimestamp, "must be an ISO 8601 date or date-time"),
  z.date().transform((date) => date.toISOString()),
]);

/** `generated` and each `verified` item: who, and when. */
const provenance = z.looseObject({
  by: z.string().min(1, "must name an actor"),
  at: timestamp,
});

const source = z.looseObject({
  id: text.optional(),
  resource: z.string().optional(),
  title: text.optional(),
  author: z.string().optional(),
  last_modified: timestamp.optional(),
});

/** OKF v0.2 fields the app reads. */
export const okfFieldsV0_2 = {
  title: text,
  description: text,
  type: text,
  status: text,
  generated: provenance,
  verified: z.array(provenance),
  stale_after: timestamp,
  sources: z.array(source),
  // a single tag written as a string is common in the wild (Obsidian allows it)
  tags: z.union([z.array(text), text.transform((tag) => [tag])]),
};

export type OkfFieldSchemas = typeof okfFieldsV0_2;
export type OkfProvenance = z.output<typeof provenance>;
export type OkfSource = z.output<typeof source>;

/** The OKF fields a note has, each present only when its value is valid. */
export type OkfFields = {
  readonly [K in keyof OkfFieldSchemas]?: z.output<OkfFieldSchemas[K]>;
};
