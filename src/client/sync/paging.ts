import { InvalidResponseError } from "../errors/index.js";

/** One page of a list ordered by `seq`. */
export interface SeqPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

/**
 * Reads a list paged by `seq` (events, comments, check records): asks again with `since` set to
 * the last item's `seq` while `hasMore` is true. With `until`, it stops once it has every item up
 * to that workspace version. A page that claims more without moving forward is refused.
 */
export async function pageBySeq<T extends { readonly seq: number }>(
  route: string,
  fetchPage: (since: number | undefined) => Promise<SeqPage<T>>,
  range: { readonly since?: number | undefined; readonly until?: number | undefined } = {},
): Promise<T[]> {
  const items: T[] = [];
  let since = range.since;
  for (;;) {
    const page = await fetchPage(since);
    items.push(...page.items);
    if (!page.hasMore) return items;
    const last = page.items.at(-1);
    if (last === undefined || (since !== undefined && last.seq <= since)) {
      throw new InvalidResponseError(route, "no progress");
    }
    if (range.until !== undefined && last.seq >= range.until) return items;
    since = last.seq;
  }
}
