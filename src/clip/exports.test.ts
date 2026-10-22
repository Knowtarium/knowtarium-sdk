import { describe, expect, it } from "vitest";

import * as protocol from "../protocol/index.js";
import * as clip from "./index.js";
import { formatClipId } from "./payload.js";

/** Everything knowtarium/clip exports at run time: what the extension can call. */
const EXPECTED = [
  "CLIP_FORMAT_VERSION",
  "CLIP_LIMITS",
  "ClipError",
  "EXTENSION_CONNECT_PAGE_PATH",
  "EXTENSION_ERROR_STATUS",
  "EXTENSION_PROTOCOL",
  "EXTENSION_ROUTES",
  "POST_CLIP_STATUS",
  "createClipId",
  "createConnectSecret",
  "createExtensionKeys",
  "extensionConfirmationCode",
  "formatExtensionConnectFragment",
  "fromBase64Url",
  "isClipError",
  "normalizeCategory",
  "normalizeClip",
  "openExtensionPairing",
  "ready",
  "signAndSealClip",
  "toBase64Url",
  "verifyExtensionKey",
  "verifyInboxKey",
];

describe("the knowtarium/clip entry", () => {
  it("exports exactly what the extension needs", () => {
    expect(Object.keys(clip).sort()).toEqual([...EXPECTED].sort());
  });

  it("opens nothing but the pairing payload", () => {
    const opening = Object.keys(clip).filter((name) => /^(open|decrypt|unwrap|unseal)/i.test(name));
    expect(opening).toEqual(["openExtensionPairing"]);
  });

  it("names the protocol's routes, limits and error statuses", () => {
    for (const [name, route] of Object.entries(clip.EXTENSION_ROUTES)) {
      const own = protocol.routes[name as keyof typeof protocol.routes];
      expect({ method: own.method, path: own.path }, name).toEqual(route);
    }
    for (const [code, status] of Object.entries(clip.EXTENSION_ERROR_STATUS)) {
      expect(protocol.ERROR_STATUS[code as protocol.ErrorCode], code).toBe(status);
    }
    // the extension stays on protocol 2 (none of its routes changed in 3), which the API accepts
    expect(clip.EXTENSION_PROTOCOL.version).toBe(2);
    expect(protocol.SUPPORTED_PROTOCOL_VERSIONS).toContain(clip.EXTENSION_PROTOCOL.version);
    expect(clip.EXTENSION_PROTOCOL.versionHeader).toBe(protocol.PROTOCOL_HEADER);
    expect(clip.EXTENSION_CONNECT_PAGE_PATH).toBe(protocol.EXTENSION_CONNECT_PAGE_PATH);
    expect(clip.CLIP_LIMITS.sealedBytes).toBe(protocol.CLIP_QUEUE_LIMITS.sealedClipBytes);
    expect(clip.CLIP_FORMAT_VERSION).toBe(protocol.SEALED_CLIP_FORMAT);
    expect(clip.POST_CLIP_STATUS).toEqual(protocol.POST_CLIP_STATUS);
    // the inbox key routes answer it when the workspace has none
    expect(clip.EXTENSION_ERROR_STATUS.inbox_not_set).toBe(protocol.ERROR_STATUS.inbox_not_set);
    expect(protocol.routes.postClip.status).toBe(protocol.POST_CLIP_STATUS.queued);
  });

  it("makes clip IDs as the protocol formats IDs", () => {
    for (const fill of [0, 7, 255]) {
      const random = new Uint8Array(16).fill(fill);
      random[3] = 42;
      expect(formatClipId(random)).toBe(protocol.formatId("clip", random));
    }
  });

  it("types the routes' bodies as the protocol does", () => {
    const signed: protocol.SignedInboxKey = {
      envelope: {
        type: "inbox_key",
        accountId: protocol.formatId("acc", new Uint8Array(16)),
        workspaceId: protocol.formatId("ws", new Uint8Array(16)),
        createdAt: "2026-10-10T09:00:00.000Z",
        revision: 1,
        generation: 1,
        publicKey: "x",
        folderId: protocol.formatId("fld", new Uint8Array(16)),
      },
      signature: "x",
    };
    const asClip: clip.SignedInboxKey = signed;
    const start: protocol.StartConnectRequest = {
      client: "extension",
      extensionVersion: "0.1.0",
    } satisfies clip.StartExtensionConnectRequest;
    const poll: clip.PollConnectResponse = {
      status: "completed",
    } satisfies protocol.PollConnectResponse;
    const posted: clip.PostClipResponse = {
      status: "duplicate",
    } satisfies protocol.PostClipResponse;
    expect([asClip, start, poll, posted]).toHaveLength(4);
  });
});
