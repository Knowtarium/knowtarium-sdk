// Full-text search over decrypted notes, in memory, with MiniSearch. The server can't search
// ciphertext, so this runs in the browser and in the CLI. `serialize` gives the index as a string
// for a local cache; the caller encrypts it with the workspace key before storing it anywhere.
import MiniSearch, { type AsPlainObject, type Options, type SearchResult } from "minisearch";

import type { Note } from "../workspace/types.js";
import {
  SEARCH_FIELDS,
  type SearchDocument,
  searchDocumentOf,
  type SearchField,
} from "./document.js";
import { type Highlight, highlightsIn, type Snippet, snippetOf } from "./snippet.js";
import { normalizeTerm, tokenize } from "./terms.js";

const FORMAT = "knowtarium-search-index";
/** Bump whenever the fields, the tokenizer or the term normalization change (2: CJK words). */
const FORMAT_VERSION = 2;

/** Field boosts: a title match outranks a body match. */
const BOOST: Readonly<Record<SearchField, number>> = {
  title: 4,
  tags: 2.5,
  description: 2,
  path: 1.5,
  properties: 1.2,
  body: 1,
};

/** The fields a snippet may come from, in order of preference (title and path show anyway). */
const SNIPPET_FIELDS = ["body", "description", "properties", "tags"] as const;

const ENGINE_OPTIONS: Options<SearchDocument> = {
  idField: "id",
  fields: [...SEARCH_FIELDS],
  storeFields: [],
  tokenize: (text) => tokenize(text),
  processTerm: (term) => normalizeTerm(term) || null,
  extractField: (document, field) => {
    const value = (document as unknown as Readonly<Record<string, unknown>>)[field];
    return typeof value === "string" ? value : "";
  },
};

export interface SearchFilters {
  /** OKF `type`s to keep, compared case-insensitively. */
  readonly types?: readonly string[];
  /** A folder path: keeps the notes in it and in its subfolders (`""` is the whole workspace). */
  readonly folder?: string;
  /** Tags the note must all have. */
  readonly tags?: readonly string[];
  /**
   * Note ids to keep. Tier, state and freshness filters depend on the clock and on signed events,
   * so the caller derives them (see `deriveVerification`) and passes the matching ids here.
   */
  readonly ids?: ReadonlySet<string>;
}

export interface SearchOptions {
  readonly filters?: SearchFilters;
  /** At most this many hits (default 50). */
  readonly limit?: number;
  /**
   * Words that start a longer word match it (default true, for search as you type). A single
   * character never does: it would match most of the index.
   */
  readonly prefix?: boolean;
  /** Words of four letters or more match with a typo or two (default true). */
  readonly fuzzy?: boolean;
  /** `and` (default): every word must match; `or`: any word may. */
  readonly combineWith?: "and" | "or";
  /** About how many characters a snippet shows (default 160). */
  readonly snippetLength?: number;
}

export interface SearchHit {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly score: number;
  /** The fields that matched. */
  readonly fields: readonly SearchField[];
  /** The words of the note that matched (normalized). */
  readonly terms: readonly string[];
  /** Matched words in `title`. */
  readonly titleHighlights: readonly Highlight[];
  /** A window of the best matching field; `null` when only the title or path matched. */
  readonly snippet: Snippet | null;
}

/** What an update did. */
export interface IndexChanges {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly unchanged: number;
}

export interface RestoredSearchIndex {
  readonly index: SearchIndex;
  readonly changes: IndexChanges;
  /** The cache was unreadable or from another format, so the index was built from scratch. */
  readonly rebuilt: boolean;
}

interface SerializedIndex {
  readonly format: typeof FORMAT;
  readonly version: typeof FORMAT_VERSION;
  readonly fields: readonly string[];
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly engine: AsPlainObject;
}

function passes(document: SearchDocument, filters: SearchFilters | undefined): boolean {
  if (filters === undefined) return true;
  const { types, folder, tags, ids } = filters;
  if (ids !== undefined && !ids.has(document.id)) return false;
  if (types !== undefined) {
    const type = document.type?.toLowerCase();
    if (type === undefined || !types.some((wanted) => wanted.toLowerCase() === type)) return false;
  }
  if (folder !== undefined && folder !== "") {
    const inside = document.folder === folder || document.folder.startsWith(`${folder}/`);
    if (!inside) return false;
  }
  if (tags !== undefined) {
    const own = new Set(document.tagList.map((tag) => tag.toLowerCase()));
    if (!tags.every((tag) => own.has(tag.toLowerCase()))) return false;
  }
  return true;
}

function isSerializedIndex(value: unknown): value is SerializedIndex {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record["format"] === FORMAT &&
    record["version"] === FORMAT_VERSION &&
    JSON.stringify(record["fields"]) === JSON.stringify(SEARCH_FIELDS) &&
    typeof record["fingerprints"] === "object" &&
    record["fingerprints"] !== null &&
    typeof record["engine"] === "object" &&
    record["engine"] !== null
  );
}

/**
 * A mutable search index over a workspace's notes. Keep one per open workspace and update it per
 * change (`upsert`, `remove`) or in one go (`sync`); both skip notes whose text hasn't changed.
 */
export class SearchIndex {
  readonly #engine: MiniSearch<SearchDocument>;
  readonly #documents = new Map<string, SearchDocument>();

  private constructor(engine: MiniSearch<SearchDocument>) {
    this.#engine = engine;
  }

  /** Builds an index of the given notes (a workspace's `notes.values()`). */
  static create(notes: Iterable<Note> = []): SearchIndex {
    const index = new SearchIndex(new MiniSearch(ENGINE_OPTIONS));
    const documents: SearchDocument[] = [];
    for (const note of notes) {
      const document = searchDocumentOf(note);
      if (index.#documents.has(document.id)) continue;
      index.#documents.set(document.id, document);
      documents.push(document);
    }
    index.#engine.addAll(documents);
    return index;
  }

  /**
   * Restores an index from `serialize` output (after the caller decrypted it), then brings it up
   * to date with the current notes: changed notes are re-indexed, removed ones dropped. An
   * unreadable cache, or one from another format, is rebuilt from the notes instead of failing.
   */
  static restore(serialized: string, notes: Iterable<Note>): RestoredSearchIndex {
    const list = [...notes];
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      parsed = undefined;
    }
    if (isSerializedIndex(parsed)) {
      try {
        const engine = MiniSearch.loadJS(parsed.engine, ENGINE_OPTIONS);
        return { ...SearchIndex.#catchUp(engine, parsed.fingerprints, list), rebuilt: false };
      } catch {
        // a cache that parsed but is inconsistent inside: start over from the notes below
      }
    }
    const index = SearchIndex.create(list);
    const changes = { added: index.size, updated: 0, removed: 0, unchanged: 0 };
    return { index, changes, rebuilt: true };
  }

  static #catchUp(
    engine: MiniSearch<SearchDocument>,
    fingerprints: Readonly<Record<string, string>>,
    notes: readonly Note[],
  ): { index: SearchIndex; changes: IndexChanges } {
    const index = new SearchIndex(engine);
    // the cache keeps fingerprints, not documents: the documents are rebuilt from the notes
    const cached = new Map(Object.entries(fingerprints).filter(([id]) => engine.has(id)));
    const counts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    const seen = new Set<string>();
    for (const note of notes) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      const document = searchDocumentOf(note);
      index.#documents.set(document.id, document);
      const fingerprint = cached.get(document.id);
      if (fingerprint === document.fingerprint) {
        counts.unchanged++;
      } else if (fingerprint === undefined) {
        if (engine.has(document.id)) engine.discard(document.id);
        engine.add(document);
        counts.added++;
      } else {
        engine.discard(document.id);
        engine.add(document);
        counts.updated++;
      }
    }
    for (const id of cached.keys()) {
      if (seen.has(id)) continue;
      engine.discard(id);
      counts.removed++;
    }
    return { index, changes: counts };
  }

  /** How many notes are indexed. */
  get size(): number {
    return this.#documents.size;
  }

  has(id: string): boolean {
    return this.#documents.has(id);
  }

  /** Adds a note or re-indexes it; does nothing when its path and text are unchanged. */
  upsert(note: Note): "added" | "updated" | "unchanged" {
    const document = searchDocumentOf(note);
    const current = this.#documents.get(document.id);
    if (current?.fingerprint === document.fingerprint) return "unchanged";
    if (current !== undefined) this.#engine.discard(document.id);
    this.#engine.add(document);
    this.#documents.set(document.id, document);
    return current === undefined ? "added" : "updated";
  }

  /** Removes a note; `false` when it wasn't indexed. */
  remove(id: string): boolean {
    if (!this.#documents.delete(id)) return false;
    this.#engine.discard(id);
    return true;
  }

  /** Makes the index match these notes exactly (a workspace's `notes.values()`). */
  sync(notes: Iterable<Note>): IndexChanges {
    const counts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    const seen = new Set<string>();
    for (const note of notes) {
      seen.add(note.id);
      counts[this.upsert(note)]++;
    }
    for (const id of [...this.#documents.keys()]) {
      if (!seen.has(id) && this.remove(id)) counts.removed++;
    }
    return counts;
  }

  /** Searches the notes: best matches first, each with a snippet and highlight positions. */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    if (tokenize(query).length === 0) return [];
    const { filters } = options;
    const results = this.#engine.search(query, {
      boost: BOOST,
      prefix: (options.prefix ?? true) ? (term) => term.length > 1 : false,
      fuzzy: (options.fuzzy ?? true) ? (term) => (term.length >= 4 ? 0.2 : false) : false,
      combineWith: options.combineWith === "or" ? "OR" : "AND",
      filter: (result) => {
        const document = this.#documents.get(String(result.id));
        return document !== undefined && passes(document, filters);
      },
    });
    return results
      .slice(0, options.limit ?? 50)
      .flatMap((result) => this.#hitOf(result, options.snippetLength));
  }

  #hitOf(result: SearchResult, snippetLength: number | undefined): SearchHit[] {
    const document = this.#documents.get(String(result.id));
    if (document === undefined) return [];
    const matched = new Set<string>(Object.values(result.match).flat());
    const fields = SEARCH_FIELDS.filter((field) => matched.has(field));
    const terms = new Set(result.terms);
    let snippet: Snippet | null = null;
    for (const field of SNIPPET_FIELDS) {
      if (!matched.has(field)) continue;
      snippet = snippetOf(field, document[field], terms, snippetLength);
      if (snippet !== null) break;
    }
    return [
      {
        id: document.id,
        path: document.path,
        title: document.title,
        score: result.score,
        fields,
        terms: [...terms],
        titleHighlights: highlightsIn(document.title, terms),
        snippet,
      },
    ];
  }

  /**
   * The index as a string, for a local cache. It holds the notes' words in plaintext: encrypt it
   * with the workspace key before it goes to IndexedDB or the CLI's cache folder.
   */
  serialize(): string {
    const fingerprints: Record<string, string> = {};
    for (const [id, document] of this.#documents) fingerprints[id] = document.fingerprint;
    const serialized: SerializedIndex = {
      format: FORMAT,
      version: FORMAT_VERSION,
      fields: SEARCH_FIELDS,
      fingerprints,
      engine: this.#engine.toJSON(),
    };
    return JSON.stringify(serialized);
  }
}

/** Builds a search index of the given notes. */
export function createSearchIndex(notes: Iterable<Note> = []): SearchIndex {
  return SearchIndex.create(notes);
}

/** Restores a search index from a decrypted cache (see `SearchIndex.restore`). */
export function restoreSearchIndex(serialized: string, notes: Iterable<Note>): RestoredSearchIndex {
  return SearchIndex.restore(serialized, notes);
}
