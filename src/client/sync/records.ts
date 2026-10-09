import {
  type CheckRecord,
  CHECKS_PAGE_MAX,
  type ListPendingQuery,
  type NoteVersion,
  type PendingChange,
  PENDING_PAGE_MAX,
  VERSIONS_PAGE_MAX,
  type CheckStatus,
  COMMENTS_PAGE_MAX,
  type NoteComment,
  type NoteId,
  routes,
} from "../../protocol/index.js";
import type { SyncContext } from "./context.js";
import { pageBySeq } from "./paging.js";

type RecordContext = Pick<SyncContext, "api" | "workspaceId">;

/**
 * Every pending change the query matches (status, note, submitting token), page by page
 * (`listPending`, ordered by `seq`).
 */
export async function fetchPending(
  context: RecordContext,
  query: Omit<ListPendingQuery, "since" | "limit"> = {},
): Promise<PendingChange[]> {
  const pages = await pageBySeq("GET /workspaces/:workspaceId/pending-changes", async (since) => {
    const { data } = await context.api.call(routes.listPending, {
      params: { workspaceId: context.workspaceId },
      query: { ...query, ...(since === undefined ? {} : { since }), limit: PENDING_PAGE_MAX },
    });
    return { items: data.pending, hasMore: data.hasMore };
  });
  // a change decided while paging comes again later (its seq moved): the latest copy wins
  const byId = new Map<string, PendingChange>();
  for (const change of pages) {
    byId.delete(change.id);
    byId.set(change.id, change);
  }
  return [...byId.values()];
}

/** Every version of a note, oldest first, page by page (`listVersions`). */
export async function fetchVersions(
  context: RecordContext,
  noteId: NoteId,
): Promise<NoteVersion[]> {
  const versions = await pageBySeq(
    "GET /workspaces/:workspaceId/notes/:noteId/versions",
    async (since) => {
      const { data } = await context.api.call(routes.listVersions, {
        params: { workspaceId: context.workspaceId, noteId },
        query: { ...(since === undefined ? {} : { since }), limit: VERSIONS_PAGE_MAX },
      });
      // the version number is this list's cursor
      return {
        items: data.versions.map((version) => ({ seq: version.version, version })),
        hasMore: data.hasMore,
      };
    },
  );
  return versions.map((entry) => entry.version);
}

/** Encrypted comments written after `since`, for one note or the whole scope, page by page. */
export function fetchComments(
  context: RecordContext,
  query: { readonly since?: number; readonly noteId?: NoteId } = {},
): Promise<NoteComment[]> {
  return pageBySeq(
    "GET /workspaces/:workspaceId/comments",
    async (since) => {
      const { data } = await context.api.call(routes.listComments, {
        params: { workspaceId: context.workspaceId },
        query: {
          ...(query.noteId === undefined ? {} : { noteId: query.noteId }),
          ...(since === undefined ? {} : { since }),
          limit: COMMENTS_PAGE_MAX,
        },
      });
      return { items: data.comments, hasMore: data.hasMore };
    },
    { since: query.since },
  );
}

/** Encrypted check records changed after `since`, by note or status, page by page. */
export function fetchChecks(
  context: RecordContext,
  query: { readonly since?: number; readonly noteId?: NoteId; readonly status?: CheckStatus } = {},
): Promise<CheckRecord[]> {
  return pageBySeq(
    "GET /workspaces/:workspaceId/checks",
    async (since) => {
      const { data } = await context.api.call(routes.listChecks, {
        params: { workspaceId: context.workspaceId },
        query: {
          ...(query.noteId === undefined ? {} : { noteId: query.noteId }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(since === undefined ? {} : { since }),
          limit: CHECKS_PAGE_MAX,
        },
      });
      return { items: data.checks, hasMore: data.hasMore };
    },
    { since: query.since },
  );
}
