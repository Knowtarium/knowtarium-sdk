export { SEARCH_FIELDS, type SearchField } from "./document.js";
export {
  createSearchIndex,
  type IndexChanges,
  type RestoredSearchIndex,
  restoreSearchIndex,
  type SearchFilters,
  type SearchHit,
  SearchIndex,
  type SearchOptions,
} from "./search-index.js";
export type { Highlight, Snippet } from "./snippet.js";
export { normalizeTerm } from "./terms.js";
