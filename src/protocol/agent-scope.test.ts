import { describe, expect, it } from "vitest";

import {
  AGENT_PERMISSIONS,
  AgentToken,
  agentScopeAllows,
  agentScopeSha256,
  ApproveConnectRequest,
  ERROR_STATUS,
  ErrorBody,
  FolderEvent,
  ListFolderEventsQuery,
  parseServerMessage,
  PendingChange,
  REQUEST_HEADERS,
  routes,
  SetRootFolderRequest,
  SignedAgentScope,
  sortAgentPermissions,
  UpdateTokenScopeRequest,
} from "./index.js";
import { b64, ct, generationSigning, id, now, sha256Hex, signing } from "./test-fixtures.js";

const token = {
  id: id("tok"),
  workspaceId: id("ws"),
  access: "read-write",
  folderIds: [],
  publicKey: b64(32),
  createdAt: now,
  lastUsedAt: null,
  revokedAt: null,
};

const signedScope = (revision = 1) => ({
  envelope: {
    type: "agent_scope",
    accountId: id("acc"),
    workspaceId: id("ws"),
    createdAt: now,
    tokenId: id("tok"),
    revision,
    scopeSha256: sha256Hex,
  },
  signature: b64(64),
  scope: { access: "read-write", folderIds: [id("fld")], permissions: ["notes.delete"] },
});

describe("agent permissions", () => {
  it("lists the six permissions in their hash order", () => {
    expect(AGENT_PERMISSIONS).toEqual([
      "notes.move",
      "notes.delete",
      "folders.create",
      "folders.rename",
      "folders.move",
      "folders.delete",
    ]);
    expect(sortAgentPermissions(["folders.delete", "notes.move", "notes.move"])).toEqual([
      "notes.move",
      "folders.delete",
    ]);
    expect(() => sortAgentPermissions(["notes.purge"])).toThrow(TypeError);
  });

  it("allows a permission only with read-write", () => {
    expect(agentScopeAllows({ access: "read-write", permissions: ["notes.move"] }, "notes.move"));
    expect(agentScopeAllows({ access: "read", permissions: ["notes.move"] }, "notes.move")).toBe(
      false,
    );
    expect(agentScopeAllows({ access: "read-write", permissions: [] }, "notes.move")).toBe(false);
  });

  it("hashes the same scope the same way, whatever the order", async () => {
    const a = await agentScopeSha256({
      access: "read-write",
      folderIds: [id("fld", 1), id("fld", 2)],
      permissions: ["notes.delete", "notes.move"],
    });
    const b = await agentScopeSha256({
      access: "read-write",
      folderIds: [id("fld", 2), id("fld", 1), id("fld", 2)],
      permissions: ["notes.move", "notes.delete"],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const read = await agentScopeSha256({ access: "read", folderIds: [], permissions: [] });
    expect(read).not.toBe(a);
  });

  it("reads tokens from older servers as revision 0 with no permissions", () => {
    const parsed = AgentToken.parse(token);
    expect(parsed.permissions).toEqual([]);
    expect(parsed.scopeRevision).toBe(0);
    expect(parsed.scope).toBeUndefined();
    const scoped = AgentToken.parse({
      ...token,
      permissions: ["notes.delete"],
      scopeRevision: 1,
      scope: signedScope(),
    });
    expect(scoped.scope?.envelope.revision).toBe(1);
    expect(AgentToken.safeParse({ ...token, permissions: ["notes.purge"] }).success).toBe(false);
  });

  it("never stores a signed scope at revision 0", () => {
    expect(SignedAgentScope.safeParse(signedScope(0)).success).toBe(false);
    expect(SignedAgentScope.safeParse(signedScope(2)).success).toBe(true);
  });

  it("refuses a scope change with repeats, or permissions without read-write", () => {
    const change = {
      baseRevision: 1,
      access: "read-write",
      folderIds: [id("fld")],
      permissions: ["notes.move"],
      ...signing,
    };
    expect(UpdateTokenScopeRequest.safeParse(change).success).toBe(true);
    expect(UpdateTokenScopeRequest.safeParse({ ...change, folderIds: [] }).success).toBe(true);
    for (const bad of [
      { ...change, access: "read" },
      { ...change, folderIds: [id("fld"), id("fld")] },
      { ...change, permissions: ["notes.move", "notes.move"] },
      { ...change, folderIds: Array.from({ length: 101 }, (_, i) => id("fld", i)) },
      { ...change, signature: undefined },
      { ...change, extra: 1 },
    ]) {
      expect(UpdateTokenScopeRequest.safeParse(bad).success).toBe(false);
    }
    expect(
      UpdateTokenScopeRequest.safeParse({ ...change, access: "read", permissions: [] }),
    ).toMatchObject({ success: true });
  });

  it("takes permissions at connect only with read-write and a signed scope", () => {
    const approval = {
      tokenId: id("tok"),
      tokenSecretSha256: b64(32),
      workspaceId: id("ws"),
      access: "read-write",
      folderIds: [],
      encName: ct,
      publicKey: b64(32),
      keyGeneration: 1,
      encWorkspaceKey: ct,
      ...signing,
      ...generationSigning,
    };
    // an older web tab: no permissions, no scope signature
    expect(ApproveConnectRequest.safeParse(approval).success).toBe(true);
    const scoped = {
      ...approval,
      permissions: ["notes.delete"],
      scopeSignedAt: now,
      scopeSignature: b64(64),
    };
    expect(ApproveConnectRequest.safeParse(scoped).success).toBe(true);
    expect(ApproveConnectRequest.safeParse({ ...scoped, access: "read" }).success).toBe(false);
    expect(ApproveConnectRequest.safeParse({ ...scoped, scopeSignature: undefined }).success).toBe(
      false,
    );
    // a signed scope without permissions, read-only too
    expect(
      ApproveConnectRequest.safeParse({ ...scoped, access: "read", permissions: [] }).success,
    ).toBe(true);
    expect(
      ApproveConnectRequest.safeParse({ ...scoped, permissions: ["notes.delete", "notes.delete"] })
        .success,
    ).toBe(false);
  });

  it("reads older pending changes as edits", () => {
    const pending = {
      id: id("pc"),
      workspaceId: id("ws"),
      noteId: id("note"),
      folderId: id("fld"),
      baseVersion: 3,
      clientNonce: b64(16),
      sizeBytes: 0,
      submittedBy: id("tok"),
      authorTokenId: id("tok"),
      createdAt: now,
      status: "open",
      decidedAt: null,
      resultingVersion: null,
      rejectionCommentId: null,
      seq: 9,
    };
    expect(PendingChange.parse(pending).kind).toBe("edit");
    expect(PendingChange.parse({ ...pending, kind: "delete" }).kind).toBe("delete");
  });

  it("says why an agent's action was refused, and the current revision on a stale base", () => {
    expect(ERROR_STATUS.permission_required).toBe(403);
    expect(ERROR_STATUS.protected_folder).toBe(403);
    expect(ERROR_STATUS.stale_agent_scope).toBe(409);
    expect(ERROR_STATUS.scope_conflict).toBe(409);
    const conflict = { error: { code: "scope_conflict", message: "x", currentRevision: 4 } };
    expect(ErrorBody.parse(conflict)).toEqual(conflict);
    expect(ErrorBody.safeParse({ error: { code: "scope_conflict", message: "x" } }).success).toBe(
      false,
    );
  });

  it("tells the agent its scope changed", () => {
    expect(parseServerMessage('{"type":"scope_changed","revision":3}')).toEqual({
      type: "scope_changed",
      revision: 3,
    });
    expect(parseServerMessage('{"type":"scope_changed","revision":0}')).toBeNull();
  });

  it("lets the web origin send the new headers", () => {
    expect(REQUEST_HEADERS).toContain("Knowtarium-Agent-Scope-Revision");
    expect(REQUEST_HEADERS).toContain("Knowtarium-Pending-Id");
  });

  it("serves folder events with the state before and after", () => {
    const event = {
      seq: 12,
      folderId: id("fld"),
      action: "renamed",
      authorId: id("tok"),
      authorTokenId: id("tok"),
      createdAt: now,
      parentBefore: null,
      parentAfter: null,
      encNameBefore: ct,
      encNameAfter: ct,
      signed: null,
    };
    expect(FolderEvent.safeParse(event).success).toBe(true);
    expect(FolderEvent.safeParse({ ...event, action: "purged" }).success).toBe(false);
    expect(ListFolderEventsQuery.safeParse({ limit: "1001" }).success).toBe(false);
    expect(ListFolderEventsQuery.parse({ since: "4", folderId: id("fld") }).since).toBe(4);
  });

  it("names the root folder by ID only", () => {
    expect(SetRootFolderRequest.safeParse({ folderId: id("fld") }).success).toBe(true);
    expect(SetRootFolderRequest.safeParse({ folderId: "" }).success).toBe(false);
    expect(routes.setRootFolder.auth).toBe("session");
    expect(routes.listTokenScopes.auth).toBe("any");
  });
});
