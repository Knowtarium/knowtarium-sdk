import { describe, expect, it } from "vitest";

import {
  ChangesResponse,
  CreateFolderRequest,
  CreateWorkspaceRequest,
  ListKeysResponse,
  NoteUploadHeaders,
  RotateKeyRequest,
  UpdateFolderRequest,
  Workspace,
} from "./index.js";
import {
  b64,
  ct,
  generationSigning,
  id,
  now,
  signedGeneration,
  signedWrappedKey,
  signing,
} from "./test-fixtures.js";

describe("workspaces and folders", () => {
  it("describes a workspace with its owner's signing key", () => {
    const workspace = {
      id: id("ws"),
      encName: ct,
      ownerId: id("acc"),
      ownerSignPublicKey: b64(32),
      keyGeneration: 1,
      currentVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    expect(Workspace.safeParse(workspace).success).toBe(true);
    expect(Workspace.safeParse({ ...workspace, ownerSignPublicKey: undefined }).success).toBe(
      false,
    );
  });

  it("creates a workspace from an id, an encrypted name and a wrapped key", () => {
    const body = {
      id: id("ws"),
      encName: ct,
      encWorkspaceKey: b64(80),
      ...signing,
      ...generationSigning,
    };
    expect(CreateWorkspaceRequest.safeParse(body).success).toBe(true);
    expect(CreateWorkspaceRequest.safeParse({ ...body, signature: undefined }).success).toBe(false);
    const withoutGeneration = { ...body, generationSignature: undefined };
    expect(CreateWorkspaceRequest.safeParse(withoutGeneration).success).toBe(false);
    expect(CreateWorkspaceRequest.safeParse({ ...body, name: "Clients" }).success).toBe(false);
    expect(CreateWorkspaceRequest.safeParse({ ...body, encName: "Clients" }).success).toBe(false);
    expect(CreateWorkspaceRequest.safeParse({ ...body, id: id("fld") }).success).toBe(false);
  });

  it("creates folders at the root or under a parent, signed", () => {
    const body = { id: id("fld"), parentId: null, encName: ct, ...signing };
    expect(CreateFolderRequest.safeParse(body).success).toBe(true);
    expect(CreateFolderRequest.safeParse({ ...body, parentId: id("fld", 2) }).success).toBe(true);
    expect(CreateFolderRequest.safeParse({ ...body, signature: undefined }).success).toBe(false);
  });

  it("renames unsigned, moves signed, and refuses an empty update", () => {
    expect(UpdateFolderRequest.safeParse({ encName: ct }).success).toBe(true);
    expect(UpdateFolderRequest.safeParse({ parentId: null, ...signing }).success).toBe(true);
    expect(
      UpdateFolderRequest.safeParse({ encName: ct, parentId: id("fld"), ...signing }).success,
    ).toBe(true);
    expect(UpdateFolderRequest.safeParse({ parentId: null }).success).toBe(false);
    expect(UpdateFolderRequest.safeParse({ encName: ct, ...signing }).success).toBe(false);
    expect(UpdateFolderRequest.safeParse({}).success).toBe(false);
  });
});

describe("keys", () => {
  it("lists wrapped keys for the account and for tokens", () => {
    const key = {
      workspaceId: id("ws"),
      keyGeneration: 1,
      encWorkspaceKey: b64(80),
      createdAt: now,
      signedGeneration: signedGeneration(),
    };
    const body = {
      workspaceKeys: [
        {
          ...key,
          recipient: { kind: "account", accountId: id("acc") },
          signed: signedWrappedKey(),
        },
        {
          ...key,
          recipient: { kind: "token", tokenId: id("tok") },
          signed: signedWrappedKey(),
        },
      ],
    };
    expect(ListKeysResponse.safeParse(body).success).toBe(true);
    const unsigned = { workspaceKeys: [{ ...key, recipient: body.workspaceKeys[0]?.recipient }] };
    expect(ListKeysResponse.safeParse(unsigned).success).toBe(false);
    const noGeneration = { ...body.workspaceKeys[0], signedGeneration: undefined };
    expect(ListKeysResponse.safeParse({ workspaceKeys: [noGeneration] }).success).toBe(false);
    const wrongType = { ...body.workspaceKeys[0], signedGeneration: signedWrappedKey() };
    expect(ListKeysResponse.safeParse({ workspaceKeys: [wrongType] }).success).toBe(false);
  });

  it("rotates with at least one wrapped copy", () => {
    const copy = {
      recipient: { kind: "account", accountId: id("acc") },
      encWorkspaceKey: b64(80),
      ...signing,
    };
    const rotate = (body: object) =>
      RotateKeyRequest.safeParse({ ...generationSigning, ...body }).success;
    expect(rotate({ keyGeneration: 2, wrappedKeys: [copy] })).toBe(true);
    expect(rotate({ keyGeneration: 2, wrappedKeys: [] })).toBe(false);
    const unsigned = { ...copy, signature: undefined };
    expect(rotate({ keyGeneration: 2, wrappedKeys: [unsigned] })).toBe(false);
    expect(rotate({ keyGeneration: 0, wrappedKeys: [copy] })).toBe(false);
    expect(
      RotateKeyRequest.safeParse({ keyGeneration: 2, wrappedKeys: [copy], ...signing }).success,
    ).toBe(false);
  });
});

describe("notes and the changes feed", () => {
  it("parses the upload headers from strings", () => {
    const parsed = NoteUploadHeaders.parse({
      "if-match": '"4"',
      "knowtarium-folder-id": id("fld"),
      "content-type": "application/octet-stream",
    });
    expect(parsed["if-match"]).toBe(4);
    for (const tag of ["4", '"-1"', 'W/"4"', '"04"', "*"]) {
      expect(
        NoteUploadHeaders.safeParse({ "if-match": tag, "knowtarium-folder-id": id("fld") }).success,
      ).toBe(false);
    }
  });

  it("carries every kind of change", () => {
    const at = { seq: 3, at: now };
    const body = {
      workspaceVersion: 9,
      hasMore: false,
      changes: [
        { kind: "workspace", ...at, encName: ct, keyGeneration: 1 },
        {
          kind: "folder",
          ...at,
          folderId: id("fld"),
          parentId: null,
          encName: ct,
          deleted: false,
          createdAt: now,
        },
        {
          kind: "note",
          ...at,
          noteId: id("note"),
          folderId: id("fld"),
          version: 2,
          sizeBytes: 900,
          authorId: id("acc"),
          deleted: false,
          createdAt: now,
        },
        { kind: "pending", ...at, pendingId: id("pc"), noteId: id("note"), status: "open" },
        { kind: "event", ...at, eventId: id("evt"), noteId: id("note") },
        { kind: "comment", ...at, commentId: id("cmt"), noteId: id("note") },
        { kind: "check", ...at, checkId: id("chk"), noteId: id("note"), status: "unapplied" },
        {
          kind: "attachment",
          ...at,
          attachmentId: id("att"),
          folderId: id("fld"),
          encMeta: ct,
          deleted: false,
          createdAt: "2026-06-01T12:00:00.000Z",
        },
      ],
    };
    expect(ChangesResponse.safeParse(body).success).toBe(true);
    const bad = { ...body, changes: [{ kind: "note", ...at, noteId: id("note") }] };
    expect(ChangesResponse.safeParse(bad).success).toBe(false);
  });
});
