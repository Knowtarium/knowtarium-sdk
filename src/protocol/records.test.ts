import { describe, expect, it } from "vitest";

import {
  CHECKS_PAGE_MAX,
  COMMENTS_PAGE_MAX,
  EVENTS_PAGE_MAX,
  ListChecksQuery,
  ListChecksResponse,
  ListCommentsQuery,
  ListCommentsResponse,
  ListEventsQuery,
  ListEventsResponse,
} from "./index.js";

const lists = [
  { name: "events", query: ListEventsQuery, response: ListEventsResponse, max: EVENTS_PAGE_MAX },
  {
    name: "comments",
    query: ListCommentsQuery,
    response: ListCommentsResponse,
    max: COMMENTS_PAGE_MAX,
  },
  { name: "checks", query: ListChecksQuery, response: ListChecksResponse, max: CHECKS_PAGE_MAX },
] as const;

describe.each(lists)("listing $name", ({ name, query, response, max }) => {
  it("pages by seq with a limit up to the maximum", () => {
    expect(max).toBe(1000);
    expect(query.parse({ since: "7", limit: "50" })).toEqual({ since: 7, limit: 50 });
    expect(query.safeParse({ limit: String(max) }).success).toBe(true);
    expect(query.safeParse({ limit: String(max + 1) }).success).toBe(false);
    expect(query.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("says whether more pages follow", () => {
    expect(response.safeParse({ [name]: [], workspaceVersion: 3, hasMore: false }).success).toBe(
      true,
    );
    expect(response.safeParse({ [name]: [], workspaceVersion: 3 }).success).toBe(false);
  });
});
