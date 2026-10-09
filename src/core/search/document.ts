// What of a note goes into the search index: its text fields, the values of its other frontmatter
// keys, and the fields the filters use.
import type { Note } from "../workspace/types.js";

/** The fields searched, in the order MiniSearch stores them. Changing them needs a new format. */
export const SEARCH_FIELDS = [
  "title",
  "description",
  "tags",
  "path",
  "properties",
  "body",
] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

/** A note as the index sees it. */
export interface SearchDocument {
  readonly id: string;
  readonly path: string;
  readonly folder: string;
  readonly type: string | null;
  readonly tagList: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly tags: string;
  readonly properties: string;
  /**
   * The frontmatter keys behind `properties`, each with its values (`["owner", "Sara, growth"]`),
   * for a snippet that names the key. Not indexed.
   */
  readonly propertyEntries: readonly (readonly [key: string, values: string])[];
  readonly body: string;
  /** Changes whenever the note's path or text does, to skip re-indexing unchanged notes. */
  readonly fingerprint: string;
}

/** Keys searched through their own field, or not searched: provenance holds actors and dates. */
const OWN_FIELD_KEYS = new Set(["title", "description", "tags", "generated", "verified"]);
const MAX_DEPTH = 4;
const MAX_PROPERTIES_LENGTH = 4000;

function collectValues(value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" && Number.isFinite(value)) out.push(String(value));
  else if (value instanceof Date && Number.isFinite(value.getTime())) out.push(value.toISOString());
  else if (Array.isArray(value)) for (const item of value) collectValues(item, depth + 1, out);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectValues(item, depth + 1, out);
  }
}

/** Every frontmatter key except the ones searched on their own, with its values. */
function propertyValues(frontmatter: Readonly<Record<string, unknown>>): [string, string[]][] {
  const entries: [string, string[]][] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (OWN_FIELD_KEYS.has(key)) continue;
    const values: string[] = [];
    collectValues(value, 0, values);
    if (values.length > 0) entries.push([key, values]);
  }
  return entries;
}

/** A fast, non-cryptographic 53-bit hash (cyrb53), as hex. Only compares a note with itself. */
export function fingerprintOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function searchDocumentOf(note: Note): SearchDocument {
  const tagList = note.fields.tags ?? [];
  const properties = propertyValues(note.frontmatter);
  return {
    id: note.id,
    path: note.path,
    folder: note.folder,
    type: note.fields.type ?? null,
    tagList,
    title: note.title,
    description: note.fields.description ?? "",
    tags: tagList.join(" "),
    properties: properties
      .flatMap(([, values]) => values)
      .join("\n")
      .slice(0, MAX_PROPERTIES_LENGTH),
    propertyEntries: properties.map(([key, values]) => [key, values.join(", ")] as const),
    body: note.body,
    fingerprint: `${fingerprintOf(`${note.path}\0${note.parsed.text}`)}:${String(note.parsed.text.length)}`,
  };
}
