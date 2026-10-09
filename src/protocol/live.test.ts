import { describe, expect, it } from "vitest";

import { LiveQuery, parseClientMessage, parseServerMessage } from "./index.js";
import { id } from "./test-fixtures.js";

describe("live messages", () => {
  it("parses server pings", () => {
    expect(parseServerMessage('{"type":"changed","workspaceVersion":12}')).toEqual({
      type: "changed",
      workspaceVersion: 12,
    });
    const decided = {
      type: "pending_decided",
      workspaceVersion: 13,
      pendingId: id("pc"),
      noteId: id("note"),
      status: "approved",
    };
    expect(parseServerMessage(JSON.stringify(decided))).toEqual(decided);
  });

  it("returns null for anything else", () => {
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage('{"type":"changed"}')).toBeNull();
    expect(parseServerMessage('{"type":"note_text","text":"secret"}')).toBeNull();
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseClientMessage('{"type":"subscribe"}')).toBeNull();
  });

  it("takes the protocol version as a query parameter", () => {
    expect(LiveQuery.parse({ protocol: "1" })).toEqual({ protocol: 1 });
    expect(LiveQuery.safeParse({}).success).toBe(false);
  });
});
