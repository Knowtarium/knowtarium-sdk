import { z } from "zod";

import { EncName, PublicKey, Signature } from "./ciphertext.js";
import { ClipId, ExtensionId, FolderId } from "./ids.js";
import {
  Base64Url,
  base64UrlLength,
  KeyGeneration,
  Ok,
  secretSchema,
  SignedTimestamp,
  Timestamp,
  Version,
} from "./primitives.js";
import { defineRoute } from "./route.js";
import { SEALED_CLIP_MIN_BYTES } from "./sealed-clip.js";
import { requiredSigningFields, SignedInboxKey } from "./signatures.js";

/*
 * The web clipper (protocol 2, added without a bump). A browser extension, paired with one
 * workspace, saves the current tab's link and title, an optional note and a category. It never
 * holds a workspace key: it signs each clip with its own Ed25519 key (which the owner vouched for
 * in `extension_key`) and seals it to the workspace's inbox public key (which the owner signed in
 * `inbox_key`). The server queues sealed clips it can't open; a client holding the workspace key
 * claims them with a lease, opens and checks them, files each as a note (whose ID is the clip's,
 * `clipNoteId`) and acks them.
 *
 * - The extension's token (`kte_`) authenticates only the routes under `/extensions/current`
 *   (`auth: "extension"`), which take the workspace from the token; every other route answers it
 *   403 `forbidden`, and those routes answer sessions and agent tokens 403 too.
 * - The inbox key and the queue live in the workspace's Durable Object. Claim, ack, release and
 *   the summary are for the workspace owner's session or a `read-write` agent token whose scope
 *   covers the inbox folder (403 `scope_denied` otherwise); `getInboxKey` and `listExtensions`
 *   follow the workspace's read rules.
 * - `postClip` checks, in this order: the token (401); the body (400 `invalid_request`); the
 *   blob's size (413 `payload_too_large`); its version byte (400 `invalid_request`); its key
 *   generation against the latest `inbox_key`'s (409 `stale_inbox_key`, with the latest signed
 *   one); 60 clips an hour per extension (429 `rate_limited`); the clip ID (the same ID pending
 *   with the same bytes, or a stored note `clipNoteId(clipId)`, deleted ones included: 200
 *   `duplicate`; pending with other bytes: 409 `already_exists`); 1,000 pending clips per workspace
 *   (429 `inbox_full`); the storage quota (402 `quota_exceeded`). It then sends `clip_added`.
 *
 * A sealed clip is `0x01 ‖ generation (uint32 BE) ‖ crypto_box_seal(padded plaintext)`: the
 * server reads only the 5 header bytes. The format is in `knowtarium/clip`.
 */

/** Limits of the clip queue, as the sync API enforces them. */
export const CLIP_QUEUE_LIMITS = {
  /** A sealed clip: its padded plaintext stays under this with the 53 bytes of overhead. */
  sealedClipBytes: 24 * 1024,
  /** The JSON body of `postClip`. */
  postClipBodyBytes: 40 * 1024,
  /** How long a claim holds its clips before another claim may take them. */
  leaseSeconds: 120,
  /** Clips one claim takes by default, and at most; clip IDs one ack or release names. */
  claimDefault: 20,
  claimMax: 50,
  /** Clips one extension may post an hour. */
  clipsPerHour: 60,
  /** Clips that may wait in one workspace's queue. */
  pendingClips: 1000,
} as const;

/**
 * The secret a paired extension sends as `Authorization: Bearer kte_...`. The web app makes it
 * at approval; the server only ever holds its SHA-256.
 */
export const ExtensionTokenSecret = secretSchema("kte");
export type ExtensionTokenSecret = z.infer<typeof ExtensionTokenSecret>;

/** A sealed clip as base64url (named `blob`): only a holder of the inbox private key opens it. */
export const SealedClip = Base64Url.min(base64UrlLength(SEALED_CLIP_MIN_BYTES)).max(
  base64UrlLength(CLIP_QUEUE_LIMITS.sealedClipBytes),
);
export type SealedClip = z.infer<typeof SealedClip>;

export const PostClipRequest = z.strictObject({ clipId: ClipId, blob: SealedClip });
export type PostClipRequest = z.infer<typeof PostClipRequest>;

/**
 * 201 `queued`, or 200 `duplicate`: the same clip ID waits with the same bytes, or its note
 * (`clipNoteId`) exists, deleted ones included. The same clip ID waiting with other bytes is 409
 * `already_exists`: a retry sends the same sealed bytes (see `signAndSealClip`).
 */
export const PostClipResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("duplicate") }),
]);
export type PostClipResponse = z.infer<typeof PostClipResponse>;

/** The HTTP status of each `postClip` answer. */
export const POST_CLIP_STATUS = { queued: 201, duplicate: 200 } as const satisfies Record<
  PostClipResponse["status"],
  number
>;

/** The extension reads its workspace's latest inbox key (also in a `stale_inbox_key` answer). */
export const ExtensionInboxKeyResponse = z.object({ inboxKey: SignedInboxKey });
export type ExtensionInboxKeyResponse = z.infer<typeof ExtensionInboxKeyResponse>;

/** A workspace's latest inbox key; null when it has no inbox yet. */
export const InboxKeyResponse = z.object({ inboxKey: SignedInboxKey.nullable() });
export type InboxKeyResponse = z.infer<typeof InboxKeyResponse>;

/**
 * The owner signs the next inbox key revision: the server checks `baseRevision` is the latest (0
 * for none; 409 `conflict` otherwise), `generation` is the current key generation (409
 * `stale_key_generation`) and `folderId` a live folder (404 `not_found`), then rebuilds
 * `inbox_key` with `revision = baseRevision + 1` and verifies it under the account's key.
 */
export const PutInboxKeyRequest = z.strictObject({
  baseRevision: Version,
  generation: KeyGeneration,
  publicKey: PublicKey,
  folderId: FolderId,
  ...requiredSigningFields,
});
export type PutInboxKeyRequest = z.infer<typeof PutInboxKeyRequest>;

export const PutInboxKeyResponse = z.object({ inboxKey: SignedInboxKey });
export type PutInboxKeyResponse = z.infer<typeof PutInboxKeyResponse>;

export const ClaimClipsRequest = z.strictObject({
  max: z.int().min(1).max(CLIP_QUEUE_LIMITS.claimMax).optional(),
});
export type ClaimClipsRequest = z.infer<typeof ClaimClipsRequest>;

/** One claimed clip: the sealed bytes, which extension posted it, and when (the server's clock). */
export const QueuedClip = z.object({
  clipId: ClipId,
  extensionId: ExtensionId,
  /** The key generation in the blob's header. */
  generation: KeyGeneration,
  blob: SealedClip,
  postedAt: Timestamp,
});
export type QueuedClip = z.infer<typeof QueuedClip>;

/** The oldest clips with no live lease, now leased to the caller for `leaseSeconds`. */
export const ClaimClipsResponse = z.object({
  clips: z.array(QueuedClip).max(CLIP_QUEUE_LIMITS.claimMax),
  leaseSeconds: z.int().positive(),
});
export type ClaimClipsResponse = z.infer<typeof ClaimClipsResponse>;

/** Clips to ack (deleted, whatever became of them) or release (their lease cleared at once). */
export const ClipIdsRequest = z.strictObject({
  clipIds: z.array(ClipId).min(1).max(CLIP_QUEUE_LIMITS.claimMax),
});
export type ClipIdsRequest = z.infer<typeof ClipIdsRequest>;

/** What waits: every clip not acked yet (`leased` of them under a live lease). */
export const ClipSummaryResponse = z.object({
  pending: z.int().nonnegative(),
  leased: z.int().nonnegative(),
  oldestPostedAt: Timestamp.nullable(),
});
export type ClipSummaryResponse = z.infer<typeof ClipSummaryResponse>;

/**
 * A paired extension: its Ed25519 key with the owner's `extension_key` signature over it
 * (`keySignedAt` and `keySignature`; a filer rebuilds the envelope and verifies it under the owner
 * key it trusts), its name (an `extension_name` blob bound to the extension ID) and its times.
 */
export const ExtensionInfo = z.object({
  extensionId: ExtensionId,
  signPublicKey: PublicKey,
  keySignedAt: SignedTimestamp,
  keySignature: Signature,
  encName: EncName,
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  lastClipAt: Timestamp.nullable(),
  /** Filers reject a clip posted after it (`postedAt` later than `revokedAt`). */
  revokedAt: Timestamp.nullable(),
});
export type ExtensionInfo = z.infer<typeof ExtensionInfo>;

export const ListExtensionsResponse = z.object({ extensions: z.array(ExtensionInfo) });
export type ListExtensionsResponse = z.infer<typeof ListExtensionsResponse>;

export const clipRoutes = {
  getInboxKey: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/inbox-key",
    auth: "any",
    summary: "The workspace's latest owner-signed inbox key, or null without an inbox",
    response: InboxKeyResponse,
  }),
  putInboxKey: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/inbox-key",
    auth: "session",
    summary: "The owner signs the next inbox key revision (a new generation or inbox folder)",
    body: PutInboxKeyRequest,
    response: PutInboxKeyResponse,
  }),
  claimClips: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/clips/claim",
    auth: "any",
    summary: "Lease the oldest waiting clips for 120 seconds",
    body: ClaimClipsRequest,
    response: ClaimClipsResponse,
  }),
  ackClips: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/clips/ack",
    auth: "any",
    summary: "Delete handled clips (filed, duplicate or rejected); unknown IDs are ignored",
    body: ClipIdsRequest,
    response: Ok,
  }),
  releaseClips: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/clips/release",
    auth: "any",
    summary: "Clear the lease of clips this client can't file",
    body: ClipIdsRequest,
    response: Ok,
  }),
  clipSummary: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/clips/summary",
    auth: "any",
    summary: "How many clips wait, how many are leased, and the oldest one's time",
    response: ClipSummaryResponse,
  }),
  listExtensions: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/extensions",
    auth: "any",
    summary: "The workspace's paired extensions, with the owner's signatures on their keys",
    response: ListExtensionsResponse,
  }),
  revokeExtension: defineRoute({
    method: "DELETE",
    path: "/workspaces/:workspaceId/extensions/:extensionId",
    auth: "session",
    summary: "The owner disconnects an extension (no key rotation: it never held one)",
    response: Ok,
  }),
  postClip: defineRoute({
    method: "POST",
    path: "/extensions/current/clips",
    auth: "extension",
    summary: "The extension queues a sealed clip",
    body: PostClipRequest,
    response: PostClipResponse,
    status: 201,
  }),
  getExtensionInboxKey: defineRoute({
    method: "GET",
    path: "/extensions/current/inbox-key",
    auth: "extension",
    summary: "The extension reads its workspace's latest inbox key",
    response: ExtensionInboxKeyResponse,
  }),
  revokeCurrentExtension: defineRoute({
    method: "DELETE",
    path: "/extensions/current",
    auth: "extension",
    summary: "The extension disconnects itself (its token stops working)",
    response: Ok,
  }),
};
