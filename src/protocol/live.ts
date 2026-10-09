import { z } from "zod";

import { CheckId, NoteId, PendingId } from "./ids.js";
import { KeyGeneration, secretSchema, Timestamp, Version } from "./primitives.js";
import { defineRoute, WEBSOCKET } from "./route.js";

/*
 * Live pings over a WebSocket per workspace (Durable Object hibernation). They say only that
 * something changed, never what: clients then pull the changes feed. Messages are JSON text frames.
 * Browsers can't set headers on a WebSocket, so the upgrade takes the protocol version as a query
 * parameter (`?protocol=2`, in place of `Knowtarium-Protocol-Version`) and authenticates with the
 * session cookie; the CLI sends its bearer token, or either may use a short-lived ticket.
 *
 * Cross-site WebSocket hijacking: SameSite=Strict keeps the cookie off cross-site upgrades, and the
 * server also checks `Origin`. An upgrade that has an `Origin` header is accepted only when it is
 * exactly the web app's origin; an upgrade without one (the CLI) must authenticate with a bearer
 * token or a ticket, never a cookie.
 */

export const LIVE_PING_INTERVAL_SECONDS = 30;

export const LiveTicket = secretSchema("ktl");

export const LiveTicketResponse = z.object({ ticket: LiveTicket, expiresAt: Timestamp });
export type LiveTicketResponse = z.infer<typeof LiveTicketResponse>;

export const LiveQuery = z.strictObject({
  protocol: z.coerce.number().int().positive(),
  ticket: LiveTicket.optional(),
});
export type LiveQuery = z.infer<typeof LiveQuery>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.int().positive(),
    workspaceVersion: Version,
  }),
  /** Something changed: pull the feed from the last version seen. */
  z.object({ type: z.literal("changed"), workspaceVersion: Version }),
  z.object({
    type: z.literal("pending_added"),
    workspaceVersion: Version,
    pendingId: PendingId,
    noteId: NoteId,
  }),
  z.object({
    type: z.literal("pending_decided"),
    workspaceVersion: Version,
    pendingId: PendingId,
    noteId: NoteId,
    status: z.enum(["approved", "rejected"]),
  }),
  z.object({
    type: z.literal("check_added"),
    workspaceVersion: Version,
    checkId: CheckId,
    noteId: NoteId,
  }),
  /** A new key generation: fetch the wrapped keys again. */
  z.object({ type: z.literal("keys_rotated"), keyGeneration: KeyGeneration }),
  /** The token or session lost access; the server closes the socket after this. */
  z.object({ type: z.literal("revoked") }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion("type", [z.object({ type: z.literal("ping") })]);
export type ClientMessage = z.infer<typeof ClientMessage>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parses a text frame from the server; null when it isn't a known message. */
export function parseServerMessage(text: string): ServerMessage | null {
  const result = ServerMessage.safeParse(parseJson(text));
  return result.success ? result.data : null;
}

/** Parses a text frame from a client; null when it isn't a known message. */
export function parseClientMessage(text: string): ClientMessage | null {
  const result = ClientMessage.safeParse(parseJson(text));
  return result.success ? result.data : null;
}

export const liveRoutes = {
  createLiveTicket: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/live-tickets",
    auth: "any",
    summary: "A single-use ticket for the WebSocket upgrade, for clients that can't send headers",
    status: 201,
    response: LiveTicketResponse,
  }),
  live: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/live",
    auth: "any",
    summary: "WebSocket upgrade for live pings",
    query: LiveQuery,
    response: WEBSOCKET,
    status: 101,
  }),
};
