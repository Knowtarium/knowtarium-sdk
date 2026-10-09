import { z } from "zod";

import { Ciphertext } from "./ciphertext.js";
import { ActorId, EventId, NoteId, TokenId, WorkspaceId } from "./ids.js";
import { QueryVersion, Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";
import { hasBothOrNeither, SignedEvent, signingFields } from "./signatures.js";

/*
 * History events. A person's `edited`, `deleted`, `approved` and `rejected` events are recorded by
 * the server from the signed write itself (writeNote, deleteNote, approvePending, rejectPending),
 * in the same request, and so is an agent's direct write (`agent_edited`, from writeNoteAsAgent,
 * signed with the agent's own key). A version 1 caller gets `unsupported_protocol` instead of a
 * page holding an `agent_edited` event (`envelopeProtocolVersion`). Agents append their other
 * events (`proposed`, `checked`) as ciphertext, unsigned; a person can append other events signed
 * as `recorded`. The type, actor and details of an appended event are inside its ciphertext.
 */

export const NoteEvent = z.object({
  id: EventId,
  workspaceId: WorkspaceId,
  noteId: NoteId,
  /** The note version the event refers to (null when it refers to none, like a proposal). */
  noteVersion: Version.nullable(),
  authorId: ActorId,
  /**
   * The agent token whose bearer secret posted it; null for a person's (session) event, as the server saw it on the request.
   * Server-asserted attribution for display (the web binds an agent's actor name to its token),
   * not proof: nothing signs it, so a server could misattribute.
   */
  authorTokenId: TokenId.nullable(),
  createdAt: Timestamp,
  /** The workspace version the event was stored at. */
  seq: Version,
  /** The event's private details; null for a signed write that has none. */
  ciphertext: Ciphertext.nullable(),
  /**
   * The envelope and signature: a person's event, or an agent's direct write (`agent_edited`,
   * under the agent's key); null for an agent's appended event.
   */
  signed: SignedEvent.nullable(),
});
export type NoteEvent = z.infer<typeof NoteEvent>;

/**
 * An appended event. A person (session) must sign it (`recorded`); an agent sends neither field.
 * The server records the event ID given here; events it records from signed writes get IDs it
 * makes.
 */
export const NewEvent = z
  .strictObject({
    id: EventId,
    noteId: NoteId,
    noteVersion: Version.nullable(),
    ciphertext: Ciphertext,
    ...signingFields,
  })
  .refine(hasBothOrNeither, { error: "Send both signedAt and signature, or neither" });
export type NewEvent = z.infer<typeof NewEvent>;

export const EVENTS_PAGE_MAX = 1000;

/**
 * Events come ordered by `seq`, each at its own workspace version. When `hasMore` is true, ask
 * again with `since` set to the last event's `seq`.
 */
export const ListEventsQuery = z.strictObject({
  noteId: NoteId.optional(),
  /** Only events stored after this workspace version. */
  since: QueryVersion.optional(),
  limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_MAX).optional(),
});
export type ListEventsQuery = z.infer<typeof ListEventsQuery>;

/**
 * A retry of `addEvent` with the same ID and body answers the stored event at its own `seq` (the
 * workspace version it was stored at), like comments and checks; never the current version.
 */
export const EventResponse = z.object({ event: NoteEvent });
export type EventResponse = z.infer<typeof EventResponse>;

export const ListEventsResponse = z.object({
  events: z.array(NoteEvent),
  workspaceVersion: Version,
  /** True when the page is full: ask again with `since` set to the last event's `seq`. */
  hasMore: z.boolean(),
});
export type ListEventsResponse = z.infer<typeof ListEventsResponse>;

export const eventRoutes = {
  listEvents: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/events",
    auth: "any",
    summary: "History events, for one note or the whole scope",
    query: ListEventsQuery,
    response: ListEventsResponse,
  }),
  addEvent: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/events",
    auth: "any",
    summary: "Append an encrypted event (signed as `recorded` when a person posts it)",
    body: NewEvent,
    response: EventResponse,
    status: 201,
  }),
};
