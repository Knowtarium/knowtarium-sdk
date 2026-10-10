import { describe, expect, it } from "vitest";

import {
  ApiError,
  ClaimClipsRequest,
  CLIP_QUEUE_LIMITS,
  ClipId,
  ClipIdsRequest,
  clipNoteId,
  ERROR_STATUS,
  ExtensionId,
  ExtensionInfo,
  formatId,
  parseExtensionConnectFragment,
  parseServerMessage,
  PostClipRequest,
  PutInboxKeyRequest,
  routes,
} from "./index.js";
import { b64, ct, id, now } from "./test-fixtures.js";

const inboxKey = {
  envelope: {
    type: "inbox_key",
    accountId: id("acc"),
    workspaceId: id("ws"),
    createdAt: now,
    revision: 2,
    generation: 3,
    publicKey: b64(32),
    folderId: id("fld"),
  },
  signature: b64(64),
};

describe("clip and extension IDs", () => {
  it("has its own prefixes, and a clip becomes the note with the same body", () => {
    const random = new Uint8Array(16).fill(9);
    const clipId = formatId("clip", random);
    expect(ClipId.safeParse(clipId).success).toBe(true);
    expect(ExtensionId.safeParse(formatId("ext", random)).success).toBe(true);
    expect(ExtensionId.safeParse(formatId("tok", random)).success).toBe(false);
    expect(clipNoteId(clipId)).toBe(formatId("note", random));
    expect(() => clipNoteId(formatId("note", random) as never)).toThrow(RangeError);
  });
});

describe("the clip queue", () => {
  it("takes a sealed clip within the size limits", () => {
    const smallest = b64(5 + 48 + 1024);
    expect(PostClipRequest.safeParse({ clipId: id("clip"), blob: smallest }).success).toBe(true);
    expect(PostClipRequest.safeParse({ clipId: id("clip"), blob: b64(1000) }).success).toBe(false);
    expect(
      PostClipRequest.safeParse({
        clipId: id("clip"),
        blob: b64(CLIP_QUEUE_LIMITS.sealedClipBytes),
      }).success,
    ).toBe(true);
    expect(
      PostClipRequest.safeParse({
        clipId: id("clip"),
        blob: b64(CLIP_QUEUE_LIMITS.sealedClipBytes + 1),
      }).success,
    ).toBe(false);
    expect(PostClipRequest.safeParse({ clipId: id("note"), blob: smallest }).success).toBe(false);
    expect(routes.postClip.status).toBe(201);
  });

  it("claims, acks and releases at most 50 clips", () => {
    expect(ClaimClipsRequest.parse({})).toEqual({});
    expect(ClaimClipsRequest.safeParse({ max: 50 }).success).toBe(true);
    expect(ClaimClipsRequest.safeParse({ max: 51 }).success).toBe(false);
    expect(ClaimClipsRequest.safeParse({ max: 0 }).success).toBe(false);
    const ids = Array.from({ length: 51 }, (_, index) => id("clip", index + 1));
    expect(ClipIdsRequest.safeParse({ clipIds: ids.slice(0, 50) }).success).toBe(true);
    expect(ClipIdsRequest.safeParse({ clipIds: ids }).success).toBe(false);
    expect(ClipIdsRequest.safeParse({ clipIds: [] }).success).toBe(false);
    expect(CLIP_QUEUE_LIMITS.leaseSeconds).toBe(120);
  });

  it("signs the next inbox key revision with the derived key and the inbox folder", () => {
    const body = {
      baseRevision: 0,
      generation: 1,
      publicKey: b64(32),
      folderId: id("fld"),
      signedAt: now,
      signature: b64(64),
    };
    expect(PutInboxKeyRequest.parse(body)).toEqual(body);
    expect(PutInboxKeyRequest.safeParse({ ...body, revision: 1 }).success).toBe(false);
    expect(PutInboxKeyRequest.safeParse({ ...body, signature: undefined }).success).toBe(false);
  });

  it("lists extensions with the owner's signature on their keys and their revocation", () => {
    const info = {
      extensionId: id("ext"),
      signPublicKey: b64(32),
      keySignedAt: now,
      keySignature: b64(64),
      encName: ct,
      createdAt: now,
      lastUsedAt: null,
      lastClipAt: null,
      revokedAt: now,
    };
    expect(ExtensionInfo.parse(info)).toEqual(info);
  });
});

describe("the web clipper's errors and live message", () => {
  it("has three new codes, and stale_inbox_key carries the latest inbox key", () => {
    expect(ERROR_STATUS.stale_inbox_key).toBe(409);
    expect(ERROR_STATUS.inbox_not_set).toBe(409);
    expect(ERROR_STATUS.inbox_full).toBe(429);
    const stale = { code: "stale_inbox_key", message: "m", inboxKey };
    expect(ApiError.parse(stale)).toEqual(stale);
    expect(ApiError.safeParse({ code: "stale_inbox_key", message: "m" }).success).toBe(false);
    expect(ApiError.parse({ code: "inbox_full", message: "m" }).code).toBe("inbox_full");
  });

  it("announces a queued clip, which older clients drop", () => {
    expect(parseServerMessage(JSON.stringify({ type: "clip_added", pending: 3 }))).toEqual({
      type: "clip_added",
      pending: 3,
    });
    expect(parseServerMessage(JSON.stringify({ type: "clip_added" }))).toBeNull();
  });
});

describe("the extension's pairing fragment", () => {
  it("reads the signing key and the one-time secret, nothing else", () => {
    const fragment = `#signPublicKey=${b64(32)}&secret=${b64(32)}`;
    expect(parseExtensionConnectFragment(fragment)).toEqual({
      signPublicKey: b64(32),
      secret: b64(32),
    });
    expect(parseExtensionConnectFragment(`${fragment}&port=4000`)).toBeNull();
    expect(parseExtensionConnectFragment(`signPublicKey=${b64(32)}`)).toBeNull();
    expect(parseExtensionConnectFragment(`${fragment}&secret=${b64(32)}`)).toBeNull();
  });
});
