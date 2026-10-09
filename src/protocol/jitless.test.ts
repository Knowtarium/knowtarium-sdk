import { afterEach, describe, expect, it, vi } from "vitest";

import { HealthResponse, isJitless, NoteMeta, routes } from "./index.js";
import { id, now } from "./test-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zod under a strict CSP", () => {
  it("is jitless once the protocol loads", () => {
    expect(isJitless()).toBe(true);
  });

  it("parses without ever touching Function", () => {
    const spy = vi.spyOn(globalThis, "Function");
    expect(
      HealthResponse.parse({ ok: true, protocolVersion: 1, supportedProtocolVersions: [1] }),
    ).toMatchObject({ ok: true });
    const meta = {
      id: id("note"),
      workspaceId: id("ws"),
      folderId: id("fld"),
      currentVersion: 1,
      sizeBytes: 10,
      updatedAt: now,
      updatedBy: id("acc"),
      createdAt: now,
      deleted: false,
    };
    for (let i = 0; i < 3; i++) expect(NoteMeta.parse(meta)).toEqual(meta);
    expect(
      routes.getNote.params.safeParse({ workspaceId: id("ws"), noteId: id("note") }).success,
    ).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
