import { describe, expect, it } from "vitest";

import { encryptText } from "./envelope.js";
import { ready } from "./sodium.js";
import { createWorkspaceKey } from "./workspace-keys.js";

// Vitest isolates test files, so libsodium is not loaded here until ready() is awaited.

describe("ready", () => {
  it("is required before any libsodium call, then idempotent", async () => {
    expect(() => createWorkspaceKey()).toThrow(expect.objectContaining({ code: "not_ready" }));
    await ready();
    await ready();
    const key = createWorkspaceKey();
    expect(
      encryptText(key, "x", { kind: "note", workspaceId: "ws_1", id: "n" }).length,
    ).toBeGreaterThan(0);
  });
});
