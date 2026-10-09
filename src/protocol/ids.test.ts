import { describe, expect, it } from "vitest";

import { ActorId, FolderId, formatId, ID_BODY_LENGTH, NoteId, WorkspaceId } from "./index.js";

describe("ids", () => {
  it("formats 16 random bytes as a prefixed 26-character id", () => {
    const value = formatId("ws", new Uint8Array(16).fill(255));
    expect(value).toMatch(/^ws_7[0-9a-hjkmnp-tv-z]{25}$/);
    expect(value.length).toBe(3 + ID_BODY_LENGTH);
    expect(formatId("ws", new Uint8Array(16))).toBe(`ws_${"0".repeat(26)}`);
  });

  it("refuses a random input of the wrong size", () => {
    expect(() => formatId("ws", new Uint8Array(15))).toThrow(RangeError);
  });

  it("accepts ids with the right prefix only", () => {
    const ws = formatId("ws", new Uint8Array(16).fill(7));
    expect(WorkspaceId.safeParse(ws).success).toBe(true);
    expect(FolderId.safeParse(ws).success).toBe(false);
    expect(NoteId.safeParse(formatId("note", new Uint8Array(16))).success).toBe(true);
  });

  it.each([
    "ws_",
    "ws_0123456789abcdefghjkmnpqr",
    "ws_0123456789abcdefghjkmnpqrst",
    "ws_0123456789ABCDEFGHJKMNPQRS",
    "ws_0123456789abcdefghijklmnop",
    "ws_8123456789abcdefghjkmnpqrs",
    "ws_z123456789abcdefghjkmnpqrs",
    "WS_0123456789abcdefghjkmnpqrs",
    " ws_0123456789abcdefghjkmnpqrs",
    42,
    null,
  ])("rejects %j as a workspace id", (value) => {
    expect(WorkspaceId.safeParse(value).success).toBe(false);
  });

  it("takes an account or a token as an actor", () => {
    expect(ActorId.safeParse(formatId("acc", new Uint8Array(16))).success).toBe(true);
    expect(ActorId.safeParse(formatId("tok", new Uint8Array(16))).success).toBe(true);
    expect(ActorId.safeParse(formatId("ws", new Uint8Array(16))).success).toBe(false);
  });
});
