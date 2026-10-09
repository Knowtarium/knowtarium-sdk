import { z } from "zod";

import { Ciphertext } from "./ciphertext.js";
import { CheckId, NoteId, TokenId, WorkspaceId } from "./ids.js";
import { QueryVersion, Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";

/*
 * An agent's consistency check of a person's edit (`record_check`): an encrypted record tied to a
 * note version, with the result, the notes checked and any conflicts inside the ciphertext. A
 * signed-in web client that syncs applies a passing check (writes the agent's `verified` entry as a
 * new version) and marks it `applied`; a failing check shows as a conflict in review until the
 * person resolves it, then it is marked `dismissed`.
 */

export const CheckStatus = z.enum(["unapplied", "applied", "dismissed"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const CheckRecord = z.object({
  id: CheckId,
  workspaceId: WorkspaceId,
  noteId: NoteId,
  /** The version the agent checked. */
  noteVersion: z.int().positive(),
  authorId: TokenId,
  /**
   * The agent token whose bearer secret posted it (checks come only from agents, so it equals `authorId`), as the server saw it on the request.
   * Server-asserted attribution for display (the web binds an agent's actor name to its token),
   * not proof: nothing signs it, so a server could misattribute.
   */
  authorTokenId: TokenId,
  createdAt: Timestamp,
  status: CheckStatus,
  /** The version that carries the agent's `verified` entry, once applied. */
  appliedVersion: z.int().positive().nullable(),
  resolvedAt: Timestamp.nullable(),
  /** The workspace version at the last change of this record. */
  seq: Version,
  ciphertext: Ciphertext,
});
export type CheckRecord = z.infer<typeof CheckRecord>;

export const NewCheck = z.strictObject({
  id: CheckId,
  noteId: NoteId,
  noteVersion: z.int().positive(),
  ciphertext: Ciphertext,
});
export type NewCheck = z.infer<typeof NewCheck>;

export const ResolveCheckRequest = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("applied"), appliedVersion: z.int().positive() }),
  z.strictObject({ status: z.literal("dismissed") }),
]);
export type ResolveCheckRequest = z.infer<typeof ResolveCheckRequest>;

export const CHECKS_PAGE_MAX = 1000;

/**
 * Check records come ordered by `seq` (the workspace version of each one's last change). When
 * `hasMore` is true, ask again with `since` set to the last record's `seq`.
 */
export const ListChecksQuery = z.strictObject({
  status: CheckStatus.optional(),
  noteId: NoteId.optional(),
  /** Only records changed after this workspace version. */
  since: QueryVersion.optional(),
  limit: z.coerce.number().int().min(1).max(CHECKS_PAGE_MAX).optional(),
});
export type ListChecksQuery = z.infer<typeof ListChecksQuery>;

/** A retry of `recordCheck` with the same ID and body answers the stored record, at its `seq`. */
export const CheckResponse = z.object({ check: CheckRecord });
export type CheckResponse = z.infer<typeof CheckResponse>;

export const ListChecksResponse = z.object({
  checks: z.array(CheckRecord),
  workspaceVersion: Version,
  /** True when the page is full: ask again with `since` set to the last record's `seq`. */
  hasMore: z.boolean(),
});
export type ListChecksResponse = z.infer<typeof ListChecksResponse>;

export const checkRoutes = {
  listChecks: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/checks",
    auth: "any",
    summary: "Encrypted check records, filtered by status or note",
    query: ListChecksQuery,
    response: ListChecksResponse,
  }),
  recordCheck: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/checks",
    auth: "agent",
    summary: "An agent records its encrypted check of a note version",
    body: NewCheck,
    response: CheckResponse,
    status: 201,
  }),
  resolveCheck: defineRoute({
    method: "PATCH",
    path: "/workspaces/:workspaceId/checks/:checkId",
    auth: "session",
    summary: "Mark a check applied (with the version it produced) or dismissed",
    body: ResolveCheckRequest,
    response: CheckResponse,
  }),
};
