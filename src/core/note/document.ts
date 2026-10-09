// The parsed yaml Document behind each Frontmatter. Kept out of the public types so a caller can't
// mutate it; only core's edit functions read it (and never mutate it: they splice text).
import type { Document } from "yaml";

import type { Frontmatter } from "./types.js";

const documents = new WeakMap<Frontmatter, Document.Parsed>();

export function attachDocument(frontmatter: Frontmatter, document: Document.Parsed): void {
  documents.set(frontmatter, document);
}

/** The parsed document of a frontmatter block that `parseNote` produced. */
export function documentOf(frontmatter: Frontmatter): Document.Parsed {
  const document = documents.get(frontmatter);
  if (document === undefined) throw new Error("This frontmatter was not produced by parseNote");
  return document;
}
