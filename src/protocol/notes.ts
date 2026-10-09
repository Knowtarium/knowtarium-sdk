import { z } from "zod";

import {
  AGENT_POLICY_REVISION_HEADER,
  CHECK_ID_HEADER,
  ETAG_HEADER,
  FOLDER_ID_HEADER,
  headerKey,
  IF_MATCH_HEADER,
  parseVersionTag,
} from "./headers.js";
import { NoteCiphertext } from "./ciphertext.js";
import { ActorId, CheckId, FolderId, NoteId, PendingId, WorkspaceId } from "./ids.js";
import { NoteEvent } from "./events.js";
import { QueryVersion, SizeBytes, Timestamp, Version } from "./primitives.js";
import { defineRoute, RAW_BYTES } from "./route.js";
import { SigningHeaders } from "./signatures.js";

/*
 * A note version is one encrypted blob, sent and fetched as raw bytes: the envelope from
 * knowtarium/crypto around the note file, the canonical JSON `{"name":"pricing.md","text":"<the
 * raw OKF markdown file>","v":1}` (knowtarium/core `encodeNoteFile`). `name` is the file name
 * within the note's folder; folders carry their own encrypted names, so the server sees no name,
 * path or title, and a rename or a move is an ordinary signed write. A pending change's blob holds
 * the same note file. `LIMITS.noteBytes` (6 MiB) applies to that encrypted, wrapped plaintext
 * (JSON escaping makes it larger than the raw note; about 4 MiB of note text fits). People write
 * versions directly, each write signed (see signatures.ts). An agent writes a version directly
 * only through `writeNoteAsAgent`, signed with its own key (`agent_edited`) and only where the
 * workspace's agent policy says `direct` (agent-policy.ts); elsewhere it sends pending changes.
 * Agents never delete notes: `deleteNote` is a person's route only.
 */

/** A version entity tag (`"3"`) in a header, parsed to the number. */
export const VersionTag = z
  .string()
  .refine((value) => parseVersionTag(value) !== null, { error: 'Expected a version tag like "3"' })
  .transform((value) => parseVersionTag(value) ?? 0);

/** A note as the server knows it: IDs, the current version, its size and who wrote it. */
export const NoteMeta = z.object({
  id: NoteId,
  workspaceId: WorkspaceId,
  folderId: FolderId,
  currentVersion: Version,
  sizeBytes: SizeBytes,
  updatedAt: Timestamp,
  updatedBy: ActorId,
  /** When version 1 was stored. */
  createdAt: Timestamp,
  /** Deleted notes keep their history; the latest version is a delete marker. */
  deleted: z.boolean(),
});
export type NoteMeta = z.infer<typeof NoteMeta>;

export const NoteVersion = z.object({
  noteId: NoteId,
  version: Version,
  sizeBytes: SizeBytes,
  authorId: ActorId,
  createdAt: Timestamp,
  /** A delete marker has no blob. */
  deleted: z.boolean(),
  /** The pending change this version was approved from, if any. */
  fromPendingId: PendingId.nullable(),
  /**
   * The version's content was removed after the workspace's history period (see history.ts):
   * still listed with its signed event, but `getVersion` answers 410 `expired` and `sizeBytes`
   * is what it took before. False for a delete marker, which never had content.
   */
  pruned: z.boolean(),
  /** When its content was removed; null unless `pruned`. */
  prunedAt: Timestamp.nullable(),
});
export type NoteVersion = z.infer<typeof NoteVersion>;

/** Headers of a raw note upload (a note version or a pending change). */
export const NoteUploadHeaders = z.object({
  /** The version the ciphertext is based on; `"0"` creates the note. A stale base answers 409. */
  [headerKey(IF_MATCH_HEADER)]: VersionTag,
  /** The folder the note sits in after this write (a different folder moves it). */
  [headerKey(FOLDER_ID_HEADER)]: FolderId,
});
export type NoteUploadHeaders = z.infer<typeof NoteUploadHeaders>;

/**
 * Headers of a person's note write: the upload headers plus the signature (`edited`), or, with
 * `Knowtarium-Check-Id`, of a write that applies an agent's passing check (`check_applied`).
 */
export const NoteWriteHeaders = NoteUploadHeaders.extend(SigningHeaders.shape).extend({
  [headerKey(CHECK_ID_HEADER)]: CheckId.optional(),
});
export type NoteWriteHeaders = z.infer<typeof NoteWriteHeaders>;

/** The agent policy revision header's value: a non-negative integer, `"0"` for no policy yet. */
export const AgentPolicyRevisionHeader = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,14})$/, { error: "Expected a policy revision" })
  .transform(Number);

/**
 * Headers of an agent's direct write: the upload headers, the signing headers (the agent's own
 * signature on `agent_edited`, never a person's) and the agent policy revision the agent checked.
 * No `Knowtarium-Check-Id`: applying a check stays a person's write.
 *
 * The server refuses, in this order:
 *
 * 1. `scope_denied`: no write access to the folder (or, for a move, to either folder).
 * 2. `agent_key_required`: the token has no vouched signing key (connected before protocol 2);
 *    the CLI proposes instead.
 * 3. `stale_agent_policy`: the revision header isn't the current policy revision; the CLI
 *    fetches the policy, checks the mode again and retries.
 * 4. `invalid_signature`: the signature doesn't verify under the token's key for the
 *    `agent_edited` the server rebuilds (`accountId` = the owner, `tokenId` = the caller,
 *    `version` = base + 1, the folder header, the body's hash, the revision header and the stored
 *    `policySha256` of that revision, `MISSING_AGENT_POLICY_SHA256` at revision 0).
 * 5. `approval_required`: the folder's effective mode (or, for a move, either folder's) is
 *    `review`; the CLI proposes instead.
 * 6. `conflict` with `currentVersion`: a stale base.
 *
 * It then stores the version, authored by the token, and records the signed event.
 */
export const AgentNoteWriteHeaders = NoteUploadHeaders.extend(SigningHeaders.shape).extend({
  [headerKey(AGENT_POLICY_REVISION_HEADER)]: AgentPolicyRevisionHeader,
});
export type AgentNoteWriteHeaders = z.infer<typeof AgentNoteWriteHeaders>;

/** Headers of a note delete: the base version plus the signature (`deleted`). */
export const NoteDeleteHeaders = z
  .object({ [headerKey(IF_MATCH_HEADER)]: VersionTag })
  .extend(SigningHeaders.shape);
export type NoteDeleteHeaders = z.infer<typeof NoteDeleteHeaders>;

/** Headers of a raw note download and of a note write's response. */
export const NoteVersionHeaders = z.object({ [headerKey(ETAG_HEADER)]: VersionTag });
export type NoteVersionHeaders = z.infer<typeof NoteVersionHeaders>;

/**
 * A write or delete (a person's, or an agent's direct write): the note, the signed event it
 * recorded, the workspace version.
 */
export const NoteWriteResponse = z.object({
  note: NoteMeta,
  event: NoteEvent,
  workspaceVersion: Version,
});
export type NoteWriteResponse = z.infer<typeof NoteWriteResponse>;

export const NoteResponse = z.object({ note: NoteMeta });
export type NoteResponse = z.infer<typeof NoteResponse>;

/** The most versions one `listVersions` page holds. */
export const VERSIONS_PAGE_MAX = 1000;

/**
 * A note's versions come oldest first. When `hasMore` is true, ask again with `since` set to the
 * last version's `version`.
 */
export const ListVersionsQuery = z.strictObject({
  /** Only versions after this one. */
  since: QueryVersion.optional(),
  limit: z.coerce.number().int().min(1).max(VERSIONS_PAGE_MAX).optional(),
});
export type ListVersionsQuery = z.infer<typeof ListVersionsQuery>;

export const ListVersionsResponse = z.object({
  versions: z.array(NoteVersion),
  /** True when the page is full: ask again with `since` set to the last version. */
  hasMore: z.boolean(),
});
export type ListVersionsResponse = z.infer<typeof ListVersionsResponse>;

/** The most note versions one `getVersions` request may ask for. */
export const VERSIONS_BATCH_MAX = 100;
/**
 * The most ciphertext bytes (decoded) one `getVersions` answer carries; the server leaves out
 * what doesn't fit, in `omitted`, so one answer stays a sane size.
 */
export const VERSIONS_BATCH_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Many versions in one request, for a pull or a first load: each exact `{ noteId, version }`
 * (as the changes feed named them). Versions only: the signed events that make them current come
 * from `listEvents`, as for single reads, and every version is verified the same way.
 */
export const GetVersionsRequest = z.strictObject({
  versions: z
    .array(z.strictObject({ noteId: NoteId, version: Version }))
    .min(1)
    .max(VERSIONS_BATCH_MAX),
});
export type GetVersionsRequest = z.infer<typeof GetVersionsRequest>;

/**
 * The versions asked for, each as its envelope in base64url (JSON, so one validated path serves
 * every client; the bytes are ciphertext either way, and request count, not size, is what made a
 * first load slow). `omitted` lists what isn't here: delete markers (no blob), versions outside
 * the caller's scope or gone (also those removed after the history period), and whatever didn't
 * fit under `VERSIONS_BATCH_MAX_BYTES`; the client reads those one by one (`getVersion`), which
 * gives each its own answer or error.
 */
export const GetVersionsResponse = z.object({
  versions: z
    .array(z.object({ noteId: NoteId, version: Version, ciphertext: NoteCiphertext }))
    .max(VERSIONS_BATCH_MAX),
  omitted: z.array(z.object({ noteId: NoteId, version: Version })).max(VERSIONS_BATCH_MAX),
});
export type GetVersionsResponse = z.infer<typeof GetVersionsResponse>;

export const noteRoutes = {
  getNote: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/notes/:noteId",
    auth: "any",
    summary: "A note's metadata",
    response: NoteResponse,
  }),
  writeNote: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/notes/:noteId",
    auth: "session",
    summary: "Store a new signed version (raw ciphertext) if the base version is still current",
    headers: NoteWriteHeaders,
    body: RAW_BYTES,
    response: NoteWriteResponse,
    responseHeaders: NoteVersionHeaders,
  }),
  writeNoteAsAgent: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/notes/:noteId/agent-version",
    auth: "agent",
    agentSigns: true,
    summary:
      "An agent stores a new version (raw ciphertext) signed with its own key, where the policy is direct",
    headers: AgentNoteWriteHeaders,
    body: RAW_BYTES,
    response: NoteWriteResponse,
    responseHeaders: NoteVersionHeaders,
  }),
  deleteNote: defineRoute({
    method: "DELETE",
    path: "/workspaces/:workspaceId/notes/:noteId",
    auth: "session",
    summary: "Delete a note as a new signed version, if the base version is still current",
    headers: NoteDeleteHeaders,
    response: NoteWriteResponse,
  }),
  listVersions: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/notes/:noteId/versions",
    auth: "any",
    summary: "A note's versions, oldest first, a page at a time",
    query: ListVersionsQuery,
    response: ListVersionsResponse,
  }),
  getVersions: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/version-batches",
    auth: "any",
    summary: "Many note versions' ciphertext at once (a pull, a first load)",
    body: GetVersionsRequest,
    response: GetVersionsResponse,
  }),
  /** 410 `expired` for a version whose content was removed after the history period. */
  getVersion: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/notes/:noteId/versions/:version",
    auth: "any",
    summary: "The raw ciphertext of one version",
    response: RAW_BYTES,
    responseHeaders: NoteVersionHeaders,
  }),
};
