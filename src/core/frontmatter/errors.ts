/**
 * Thrown by a frontmatter edit that can't be made safely: the frontmatter doesn't parse, a field has
 * a shape the edit can't extend, or a value is invalid. Reading never throws; only writing is strict.
 */
export class FrontmatterEditError extends Error {
  override readonly name = "FrontmatterEditError";
}
