import { beforeAll, describe, expect, it } from "vitest";

import { decryptAttachment, encryptAttachment } from "./attachment.js";
import { ready } from "./sodium.js";
import { createWorkspaceKey, type WorkspaceKey } from "./workspace-keys.js";

beforeAll(ready);

describe("attachments", () => {
  const attachment = { workspaceId: "ws_1", attachmentId: "att_1" };
  const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
  let key: WorkspaceKey;
  beforeAll(() => {
    key = createWorkspaceKey();
  });

  it("round-trips in chunks, including an empty file and an exact multiple", () => {
    const chunks = encryptAttachment(key, data, attachment, 300);
    expect(chunks).toHaveLength(4);
    expect(decryptAttachment(key, chunks, attachment)).toEqual(data);
    expect(encryptAttachment(key, data, attachment, 250)).toHaveLength(4);
    const empty = encryptAttachment(key, new Uint8Array(), attachment);
    expect(empty).toHaveLength(1);
    expect(decryptAttachment(key, empty, attachment)).toEqual(new Uint8Array());
  });

  it("detects dropped, reordered, repeated and foreign chunks", () => {
    const chunks = encryptAttachment(key, data, attachment, 300);
    const other = encryptAttachment(key, data, { ...attachment, attachmentId: "att_2" }, 300);
    const [a, b, c, d] = chunks as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const broken = [[a, b, c], [a], [b, a, c, d], [a, b, c, d, d], [a, b, c, other[3] ?? d], []];
    for (const set of broken) {
      expect(() => decryptAttachment(key, set, attachment)).toThrow(
        expect.objectContaining({ code: "decryption_failed" }),
      );
    }
  });

  it("refuses a bad chunk size", () => {
    expect(() => encryptAttachment(key, data, attachment, 0)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});
