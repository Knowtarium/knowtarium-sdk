import { beforeAll, describe, expect, it } from "vitest";

import { ready, verifyEnvelopeFor } from "../../crypto/index.js";
import {
  type AgentPermission,
  agentScopeSha256,
  SIGNATURE_MAX_SKEW_SECONDS,
  type FolderId,
  routes,
} from "../../protocol/index.js";
import { isSyncApiError, RequestValidationError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { type Client, World } from "../testing/world.js";
import {
  fetchTokenScopes,
  MemoryTrustStorage,
  prepareConnectScope,
  prepareFolder,
  signAgentDeleted,
  signAgentFolderCreated,
  signAgentFolderDeleted,
  signAgentFolderMoved,
  signAgentFolderRenamed,
  signAgentScope,
  toSignedEnvelope,
  type TokenScopes,
  TrustState,
  updateTokenScope,
  verifyAgentScope,
} from "../vault/index.js";
import { createApiClient } from "../api/index.js";
import { EncryptedCache, MemoryCacheAdapter } from "../cache/index.js";

beforeAll(ready);

const note = (title: string) => `---\ntype: Note\ntitle: ${title}\n---\nBody of ${title}.\n`;

/** A top-level folder the owner makes in the web app. */
async function folder(world: World, web: Client, name: string, parentId: FolderId | null = null) {
  const request = prepareFolder(world.signer, world.key, {
    workspaceId: world.workspaceId,
    parentId,
    name,
    rootFolderId: null,
  });
  await web.api.call(routes.createFolder, {
    params: { workspaceId: world.workspaceId },
    body: request,
  });
  return request.id;
}

/** A workspace with a folder, a note in it, and an agent holding `permissions`. */
async function seeded(permissions: readonly AgentPermission[] = []) {
  const world = new World();
  const web = world.web();
  const cli = world.cli();
  const home = await folder(world, web, "Home");
  const noteId = newId("note");
  await web.engine.writeNote({
    noteId,
    folderId: home,
    baseVersion: 0,
    name: "a.md",
    text: note("A"),
  });
  const granted = await world.grantScope({ permissions });
  expect(granted.status).toBe("saved");
  await cli.engine.pull();
  return { world, web, cli, home, noteId, scopeRevision: world.server.scopeRevision };
}

const sessionApi = (world: World) =>
  createApiClient({
    baseUrl: "https://api.test",
    fetch: world.server.fetch,
    auth: { kind: "session" },
  });

describe("the agents' envelopes", () => {
  it("signs each protocol 3 action with the agent's own key, naming both revisions", () => {
    const world = new World();
    const agent = {
      tokenId: world.tokenId,
      ownerAccountId: world.accountId,
      signing: world.agentSigning,
    };
    const revisions = { revision: 2, policySha256: "a".repeat(64), scopeRevision: 3 };
    const common = { workspaceId: world.workspaceId, ...revisions };
    const folderId = newId("fld");
    const actions = [
      signAgentDeleted(agent, {
        ...common,
        noteId: newId("note"),
        folderId,
        baseVersion: 4,
      }),
      signAgentFolderCreated(agent, {
        ...common,
        folderId,
        parentId: null,
        encName: new Uint8Array(9),
      }),
      signAgentFolderRenamed(agent, { ...common, folderId, encName: new Uint8Array(9) }),
      signAgentFolderMoved(agent, { ...common, folderId, parentId: newId("fld") }),
      signAgentFolderDeleted(agent, { ...common, folderId }),
    ];
    for (const action of actions) {
      const { envelope } = action.signed;
      expect(envelope).toMatchObject({
        accountId: world.accountId,
        tokenId: world.tokenId,
        ...revisions,
      });
      expect(
        verifyEnvelopeFor(action.signed, world.agentSigning.publicKey, { type: envelope.type }),
      ).toBe(true);
      // never the owner's key
      expect(
        verifyEnvelopeFor(action.signed, world.account.signing.publicKey, { type: envelope.type }),
      ).toBe(false);
    }
    expect(actions[0]?.signed.envelope.version).toBe(5);
    // a folder at the top level carries no parentId
    expect("parentId" in (actions[1]?.signed.envelope ?? {})).toBe(false);
  });

  it("refuses a signing time out of range, naming where it travels", () => {
    const world = new World();
    expect(() =>
      signAgentScope(world.signer, {
        workspaceId: world.workspaceId,
        tokenId: world.tokenId,
        revision: 1,
        scopeSha256: "0".repeat(64),
        route: "approveConnect",
        signedAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toThrow(RequestValidationError);
  });
});

describe("agent scopes", () => {
  const trustOf = (world: World, minRevision = 0) => ({
    ownerSigningPublicKey: world.account.signing.publicKey,
    accountId: world.accountId,
    workspaceId: world.workspaceId,
    tokenId: world.tokenId,
    minRevision,
  });

  it("verifies the owner's signed scope, and refuses another token, hash or a rollback", async () => {
    const { world } = await seeded(["notes.delete", "notes.move"]);
    const { data } = await world.cli().api.call(routes.getCurrentToken);
    const signed = data.token.scope;
    expect(data.token.permissions).toEqual(["notes.move", "notes.delete"]);
    const ok = await verifyAgentScope(signed, trustOf(world));
    expect(ok).toMatchObject({ ok: true, revision: 1 });
    expect(ok.ok && ok.verified?.scope.permissions).toEqual(["notes.move", "notes.delete"]);
    if (signed == null) throw new Error("no scope");
    expect(await verifyAgentScope(signed, { ...trustOf(world), tokenId: newId("tok") })).toEqual({
      ok: false,
      problem: "wrong_token",
    });
    expect(
      await verifyAgentScope(
        { ...signed, scope: { ...signed.scope, permissions: ["folders.delete"] } },
        trustOf(world),
      ),
    ).toEqual({ ok: false, problem: "hash_mismatch" });
    expect(
      await verifyAgentScope(signed, {
        ...trustOf(world),
        ownerSigningPublicKey: world.agentSigning.publicKey,
      }),
    ).toEqual({ ok: false, problem: "bad_signature" });
    expect(await verifyAgentScope(signed, trustOf(world, 2))).toEqual({
      ok: false,
      problem: "rollback",
    });
    // revision 0: no signed scope, accepted only while nothing higher was seen
    expect(await verifyAgentScope(null, trustOf(world))).toEqual({
      ok: true,
      revision: 0,
      verified: null,
    });
    expect(await verifyAgentScope(null, trustOf(world, 1))).toEqual({
      ok: false,
      problem: "rollback",
    });
  });

  it("signs the connect-time scope at revision 1, dropping permissions from a read token", async () => {
    const world = new World();
    const fields = await prepareConnectScope(world.signer, {
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      access: "read",
      folderIds: [],
      permissions: ["notes.delete"],
    });
    expect(fields.permissions).toEqual([]);
    const scopeSha256 = await agentScopeSha256({ access: "read", folderIds: [], permissions: [] });
    const envelope = {
      type: "agent_scope" as const,
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      revision: 1,
      scopeSha256,
      createdAt: fields.scopeSignedAt,
    };
    expect(
      verifyEnvelopeFor(
        toSignedEnvelope({ envelope, signature: fields.scopeSignature }),
        world.account.signing.publicKey,
        envelope,
      ),
    ).toBe(true);
  });

  it("changes a scope on the current revision, conflicts on a stale one, and takes a retry", async () => {
    const world = new World();
    const trust = new TrustState(new MemoryTrustStorage());
    const change = {
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      baseRevision: 0,
      access: "read-write" as const,
      folderIds: [],
      permissions: ["folders.create" as const],
    };
    const first = await updateTokenScope(
      sessionApi(world),
      { signer: world.signer, trust },
      change,
    );
    expect(first.status).toBe("saved");
    expect(await trust.agentScopeRevision(world.tokenId)).toBe(1);
    // the same change again (a lost answer): it stands, as the server stored it
    const again = await updateTokenScope(sessionApi(world), { signer: world.signer }, change);
    expect(again.status).toBe("saved");
    expect(world.server.scopeRevision).toBe(1);
    // another change on that stale base conflicts
    const stale = await updateTokenScope(
      sessionApi(world),
      { signer: world.signer },
      { ...change, permissions: ["notes.delete"] },
    );
    expect(stale).toEqual({ status: "conflict", currentRevision: 1 });
    // a base below what this device verified: refused here, with nothing signed or sent
    const sent = world.server.requests.length;
    expect(
      await updateTokenScope(
        sessionApi(world),
        { signer: world.signer, trust },
        { ...change, permissions: ["notes.move"] },
      ),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    expect(world.server.requests.length).toBe(sent);
  });

  it("reads every revision, flagging a gap or a list below the device's floor", async () => {
    const world = new World();
    await world.grantScope({ permissions: ["notes.delete"] });
    await world.grantScope({ permissions: ["notes.delete", "folders.create"] });
    await world.grantScope({ permissions: [] });
    const trust = new TrustState(new MemoryTrustStorage());
    const read = () =>
      fetchTokenScopes(sessionApi(world), {
        ownerSigningPublicKey: world.account.signing.publicKey,
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        tokenId: world.tokenId,
        trust,
      });
    const whole = await read();
    expect(whole.problem).toBeNull();
    expect(whole.scopes.map((scope) => scope.revision)).toEqual([1, 2, 3]);
    world.server.tamper.scopes = (scopes) => scopes.filter((s) => s.envelope.revision !== 2);
    expect((await read()).problem).toBe("gap");
    world.server.tamper.scopes = (scopes) => scopes.slice(0, 2);
    expect((await read()).problem).toBe("below_floor");
  });
});

describe("an agent's note delete", () => {
  it("deletes a note directly with its own signature, which the web app verifies", async () => {
    const { world, web, cli, noteId, scopeRevision } = await seeded(["notes.delete"]);
    const result = await cli.engine.deleteAsAgent({
      noteId,
      baseVersion: 1,
      scopeRevision,
      record: { actor: "claude-code/2.1", summary: "Duplicate of B" },
    });
    expect(result).toMatchObject({ status: "saved", recorded: true });
    expect(result.status === "saved" && result.note.text).toBeNull();
    expect(world.server.agentNoteDeletes).toBe(1);
    // the web app pulls the agent's delete marker, verified under the agent's vouched key
    const seen: { noteId: string; text: string | null }[] = [];
    web.engine.on("note", (event) => seen.push(event.note));
    await web.engine.pull();
    expect(seen).toContainEqual(expect.objectContaining({ noteId, text: null }));
    expect(web.engine.quarantined).toEqual([]);
    const timeline = await web.engine.readHistory(noteId);
    const marker = timeline.entries.find(
      (entry) => entry.kind === "version" && entry.event?.event.type === "agent_deleted",
    );
    expect(marker).toMatchObject({
      signature: "verified",
      event: { agent: { tokenId: world.tokenId, revoked: false } },
    });
  });

  it("verifies a cached agent delete again when the cache loads, and the root marker with it", async () => {
    const { world, web, cli, home, noteId, scopeRevision } = await seeded(["notes.delete"]);
    await cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision });
    await web.api.call(routes.setRootFolder, {
      params: { workspaceId: world.workspaceId },
      body: { folderId: home },
    });
    const adapter = new MemoryCacheAdapter();
    const first = world.web({ cache: new EncryptedCache(adapter) });
    await first.engine.pull();
    const second = world.web({ cache: new EncryptedCache(adapter) });
    const seen: { noteId: string; text: string | null }[] = [];
    second.engine.on("note", (event) => seen.push(event.note));
    await second.engine.load();
    expect(seen).toContainEqual(expect.objectContaining({ noteId, text: null }));
    expect(second.engine.quarantined).toEqual([]);
    expect(second.engine.rootFolderId).toBe(home);
  });

  it("is refused without notes.delete, and under a scope revision that moved on", async () => {
    const { world, cli, noteId, scopeRevision } = await seeded([]);
    await expect(
      cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision }),
    ).rejects.toSatisfy((error) => isSyncApiError(error, "permission_required"));
    await world.grantScope({ permissions: ["notes.delete"] });
    await expect(
      cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision }),
    ).rejects.toSatisfy((error) => isSyncApiError(error, "stale_agent_scope"));
  });

  it("proposes the delete where the folder asks first, approved by the person's own delete", async () => {
    const { world, web, cli, home, noteId, scopeRevision } = await seeded(["notes.delete"]);
    const policy = await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: home, mode: "review" }],
      baseRevision: 0,
    });
    expect(policy.status).toBe("saved");
    const direct = await cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision });
    expect(direct).toMatchObject({ status: "approval_required", reason: "policy" });
    const proposed = await cli.engine.proposeDelete({ noteId, baseVersion: 1 });
    if (proposed.status !== "submitted") throw new Error("not submitted");
    expect(proposed.pending).toMatchObject({ kind: "delete", sizeBytes: 0, folderId: home });
    // one open delete proposal per note
    await expect(cli.engine.proposeDelete({ noteId, baseVersion: 1 })).rejects.toSatisfy((error) =>
      isSyncApiError(error, "already_exists"),
    );
    const review = await web.engine.readPending(proposed.pending.id);
    expect(review).toMatchObject({ kind: "delete", proposedName: null, proposed: "" });
    expect(review.base?.text).toBe(note("A"));
    // approvePending never takes a delete; the person's own delete does
    await expect(
      web.engine.approvePending(proposed.pending, { name: "a.md", text: "x" }, { takenNames: [] }),
    ).rejects.toThrow(RequestValidationError);
    const approved = await web.engine.approveDelete(proposed.pending);
    expect(approved).toMatchObject({
      status: "approved",
      pending: { status: "approved", resultingVersion: 2 },
    });
    expect(world.server.notes.get(noteId)?.versions.at(-1)?.deleted).toBe(true);
  });

  it("undoes an agent's delete as the person's write, unless its folder is gone", async () => {
    const { web, cli, noteId, scopeRevision } = await seeded(["notes.delete"]);
    await cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision });
    await web.engine.pull();
    const undone = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] });
    expect(undone).toMatchObject({ status: "saved", note: { version: 3 } });
    expect(undone.status === "saved" && undone.note.text).toContain("Body of A.");
    // a retry is answered from what landed
    expect(await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] })).toMatchObject({
      status: "saved",
    });
  });

  it("answers folder_missing when the note's folder was deleted since", async () => {
    const { world, web, cli, home, noteId, scopeRevision } = await seeded(["notes.delete"]);
    await cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision });
    await web.api.call(routes.deleteFolder, {
      params: { workspaceId: world.workspaceId, folderId: home },
    });
    await web.engine.pull();
    expect(await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] })).toEqual({
      status: "folder_missing",
      folderId: home,
    });
  });

  it("needs notes.move to move a note, directly or as a proposal", async () => {
    const { world, web, cli, noteId, scopeRevision } = await seeded([]);
    const other = await folder(world, web, "Other");
    await cli.engine.pull();
    const move = { noteId, folderId: other, baseVersion: 1, name: "a.md", text: note("A") };
    await expect(cli.engine.writeAsAgent(move)).rejects.toSatisfy((error) =>
      isSyncApiError(error, "permission_required"),
    );
    await expect(cli.engine.submitPending(move)).rejects.toSatisfy((error) =>
      isSyncApiError(error, "permission_required"),
    );
    expect(scopeRevision).toBe(1);
    await world.grantScope({ permissions: ["notes.move"] });
    expect((await cli.engine.writeAsAgent(move)).status).toBe("saved");
  });
});

describe("an agent's folder changes", () => {
  const all: AgentPermission[] = [
    "folders.create",
    "folders.rename",
    "folders.move",
    "folders.delete",
  ];

  it("creates, renames, moves and deletes folders, each in the verified folder history", async () => {
    const { world, web, cli, home, scopeRevision } = await seeded(all);
    const created = await cli.engine.createFolderAsAgent({
      parentId: home,
      name: "Drafts",
      scopeRevision,
    });
    if (created.status !== "saved") throw new Error(created.status);
    const id = created.folder.id;
    expect(
      (await cli.engine.renameFolderAsAgent({ folderId: id, name: "Old drafts", scopeRevision }))
        .status,
    ).toBe("saved");
    const moved = await cli.engine.moveFolderAsAgent({
      folderId: id,
      parentId: null,
      scopeRevision,
    });
    expect(moved).toMatchObject({ status: "saved", folder: { parentId: null } });
    expect((await cli.engine.deleteFolderAsAgent({ folderId: id, scopeRevision })).status).toBe(
      "saved",
    );
    const events = await web.engine.readFolderEvents({ folderId: id });
    expect(events.map((entry) => [entry.event.action, entry.signature])).toEqual([
      ["created", "verified"],
      ["renamed", "verified"],
      ["moved", "verified"],
      ["deleted", "verified"],
    ]);
    expect(events[1]).toMatchObject({ nameBefore: "Drafts", nameAfter: "Old drafts" });
    expect(events.every((entry) => entry.agent?.tokenId === world.tokenId)).toBe(true);
    // a person's rename is the server's word, unsigned
    await web.api.call(routes.updateFolder, {
      params: { workspaceId: world.workspaceId, folderId: home },
      body: {
        encName: prepareFolder(world.signer, world.key, {
          workspaceId: world.workspaceId,
          parentId: null,
          name: "x",
          rootFolderId: null,
        }).encName,
      },
    });
    const person = await web.engine.readFolderEvents({ folderId: home });
    expect(person.at(-1)).toMatchObject({ signature: "unsigned", agent: null });
  });

  it("refuses its own scope folders, the root folder, another permission, and folders that ask first", async () => {
    const { world, web, cli, home, scopeRevision } = await seeded(["folders.rename"]);
    const refused = async (
      run: () => Promise<unknown>,
      code: Parameters<typeof isSyncApiError>[1],
    ) => expect(run()).rejects.toSatisfy((error) => isSyncApiError(error, code));
    world.server.otherScopeFolderIds = [home];
    await refused(
      () => cli.engine.renameFolderAsAgent({ folderId: home, name: "Mine", scopeRevision }),
      "protected_folder",
    );
    world.server.otherScopeFolderIds = [];
    await web.api.call(routes.setRootFolder, {
      params: { workspaceId: world.workspaceId },
      body: { folderId: home },
    });
    await refused(
      () => cli.engine.renameFolderAsAgent({ folderId: home, name: "Mine", scopeRevision }),
      "protected_folder",
    );
    const other = await folder(world, web, "Other");
    await cli.engine.pull();
    await refused(
      () => cli.engine.deleteFolderAsAgent({ folderId: other, scopeRevision }),
      "permission_required",
    );
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    expect(
      await cli.engine.renameFolderAsAgent({ folderId: other, name: "Renamed", scopeRevision }),
    ).toMatchObject({ status: "approval_required", reason: "policy" });
  });

  it("undoes each folder change as the person's own, saying when it can't", async () => {
    const { world, web, cli, home, scopeRevision } = await seeded(all);
    const made = await cli.engine.createFolderAsAgent({
      parentId: home,
      name: "New",
      scopeRevision,
    });
    if (made.status !== "saved") throw new Error(made.status);
    const id = made.folder.id;
    await cli.engine.renameFolderAsAgent({ folderId: id, name: "Renamed", scopeRevision });
    const target = await folder(world, web, "Target");
    await cli.engine.pull();
    await cli.engine.moveFolderAsAgent({ folderId: id, parentId: target, scopeRevision });
    const events = await web.engine.readFolderEvents({ folderId: id });
    const [created, renamed, moved] = events;
    if (created === undefined || renamed === undefined || moved === undefined)
      throw new Error("events");
    // newest first: the move, then the rename, then the create
    expect(await web.engine.undoAgentFolderEvent(moved)).toMatchObject({
      status: "saved",
      folder: { parentId: home },
    });
    expect(await web.engine.undoAgentFolderEvent(moved)).toMatchObject({ status: "saved" });
    expect(await web.engine.undoAgentFolderEvent(renamed)).toMatchObject({ status: "saved" });
    const names = await web.engine.readFolderEvents({ folderId: id });
    expect(names.at(-1)).toMatchObject({ event: { action: "renamed" }, nameAfter: "New" });
    // a created folder that holds a note can't be deleted
    await web.engine.writeNote({
      noteId: newId("note"),
      folderId: id,
      baseVersion: 0,
      name: "n.md",
      text: note("N"),
    });
    expect(await web.engine.undoAgentFolderEvent(created)).toEqual({ status: "not_empty" });
  });

  it("revives a deleted folder under its own ID and stored parent", async () => {
    const { world, web, cli, home, scopeRevision } = await seeded(all);
    const made = await cli.engine.createFolderAsAgent({
      parentId: home,
      name: "Gone",
      scopeRevision,
    });
    if (made.status !== "saved") throw new Error(made.status);
    await cli.engine.deleteFolderAsAgent({ folderId: made.folder.id, scopeRevision });
    const deleted = (await web.engine.readFolderEvents({ folderId: made.folder.id })).at(-1);
    if (deleted === undefined) throw new Error("no event");
    // a revive under another parent is refused
    const elsewhere = prepareFolder(world.signer, world.key, {
      workspaceId: world.workspaceId,
      parentId: null,
      name: "Gone",
      rootFolderId: null,
      folderId: made.folder.id,
    });
    await expect(
      web.api.call(routes.createFolder, {
        params: { workspaceId: world.workspaceId },
        body: elsewhere,
      }),
    ).rejects.toSatisfy((error) => isSyncApiError(error, "invalid_request"));
    const revived = await web.engine.undoAgentFolderEvent(deleted);
    expect(revived).toMatchObject({
      status: "saved",
      folder: { id: made.folder.id, parentId: home },
    });
    const history = await web.engine.readFolderEvents({ folderId: made.folder.id });
    // the rows as FolderEvent's table has them
    expect(history.at(-2)).toMatchObject({
      event: { action: "deleted", parentBefore: home, parentAfter: null, encNameAfter: null },
      nameBefore: "Gone",
      nameAfter: null,
    });
    expect(history.at(-1)).toMatchObject({
      event: { action: "restored", parentBefore: home, parentAfter: home },
      nameBefore: "Gone",
      nameAfter: "Gone",
      signature: "verified",
    });
  });

  it("answers parent_missing when the parent it goes back under is gone", async () => {
    const { world, web, cli, home, scopeRevision } = await seeded(all);
    const made = await cli.engine.createFolderAsAgent({
      parentId: home,
      name: "Child",
      scopeRevision,
    });
    if (made.status !== "saved") throw new Error(made.status);
    await cli.engine.moveFolderAsAgent({ folderId: made.folder.id, parentId: null, scopeRevision });
    // the old parent goes (its note first)
    const [noteId] = [...world.server.notes.keys()];
    if (noteId === undefined) throw new Error("no note");
    await web.engine.pull();
    await web.engine.deleteNote({ noteId, baseVersion: 1 });
    await web.api.call(routes.deleteFolder, {
      params: { workspaceId: world.workspaceId, folderId: home },
    });
    const moved = (await web.engine.readFolderEvents({ folderId: made.folder.id })).at(-1);
    if (moved === undefined) throw new Error("no event");
    expect(await web.engine.undoAgentFolderEvent(moved)).toEqual({
      status: "parent_missing",
      parentId: home,
    });
  });
});

describe("auditing an agent's actions", () => {
  /** An agent deleted a note under scope revision 1; the person's engine knows the folders. */
  async function audited() {
    const seed = await seeded(["notes.delete"]);
    const { world, web, cli, noteId, scopeRevision } = seed;
    await cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision });
    await web.engine.pull();
    const [action] = await web.engine.agentActions({ sinceMs: 60_000 });
    if (action === undefined) throw new Error("no action");
    const trust = new TrustState(new MemoryTrustStorage());
    const scopes = () =>
      fetchTokenScopes(sessionApi(world), {
        ownerSigningPublicKey: world.account.signing.publicKey,
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        tokenId: world.tokenId,
        trust,
      });
    return { ...seed, action, scopes };
  }

  /** The revisions as listed, with revision `revision` signed `shiftMs` later than it was. */
  const shifted = (listed: TokenScopes, revision: number, shiftMs: number): TokenScopes => ({
    ...listed,
    scopes: listed.scopes.map((scope) =>
      scope.revision === revision
        ? { ...scope, signedAt: new Date(Date.parse(scope.signedAt) + shiftMs).toISOString() }
        : scope,
    ),
  });

  it("allows an action under the revision in force when it was signed", async () => {
    const { world, web, action, noteId, scopes } = await audited();
    expect(action).toMatchObject({ kind: "deleted", noteId, tokenId: world.tokenId });
    expect(await web.engine.auditAgentAction(action, await scopes())).toMatchObject({
      verdict: "allowed",
      scopeRevision: 1,
      policy: { status: "consistent", mode: "direct" },
    });
    // a later narrowing doesn't change the verdict: the revision in force then counts
    await world.grantScope({ permissions: [] });
    expect((await web.engine.auditAgentAction(action, await scopes())).verdict).toBe("allowed");
    // a gap in the revisions, or a list below the floor, can't be checked
    world.server.tamper.scopes = (list) => list.filter((s) => s.envelope.revision !== 1);
    expect(await web.engine.auditAgentAction(action, await scopes())).toEqual({
      verdict: "unchecked",
      reason: "gap",
    });
    world.server.tamper.scopes = (list) => list.slice(0, 1);
    expect(await web.engine.auditAgentAction(action, await scopes())).toEqual({
      verdict: "unchecked",
      reason: "below_floor",
    });
  });

  it("allows for the signature clock skew, and no more", async () => {
    const { world, web, action, scopes } = await audited();
    await world.grantScope({ permissions: ["notes.delete", "notes.move"] });
    const listed = await scopes();
    const skew = SIGNATURE_MAX_SKEW_SECONDS * 1000;
    const audit = (list: TokenScopes) => web.engine.auditAgentAction(action, list);
    // revision 1 signed a little after the action, within the skew: still in force
    expect((await audit(shifted(listed, 1, 120_000))).verdict).toBe("allowed");
    // signed later than the skew allows: not the revision in force
    expect(await audit(shifted(listed, 1, skew + 60_000))).toMatchObject({
      verdict: "not_allowed",
      reason: "other_revision",
    });
    // revision 2 signed a little before the action (in flight meanwhile): 1 still counts
    const second = listed.scopes[1];
    if (second === undefined) throw new Error("no second revision");
    const at = Date.parse(action.createdAt);
    const before = (ms: number) => shifted(listed, 2, at - ms - Date.parse(second.signedAt));
    expect((await audit(before(120_000))).verdict).toBe("allowed");
    expect(await audit(before(skew + 60_000))).toMatchObject({
      verdict: "not_allowed",
      reason: "other_revision",
    });
  });

  it("flags an action its scope's permission didn't allow, and won't judge by another token's", async () => {
    const { web, action, scopes } = await audited();
    const listed = await scopes();
    const [first] = listed.scopes;
    if (first === undefined) throw new Error("no scope");
    const narrowed = {
      ...listed,
      scopes: [{ ...first, scope: { ...first.scope, permissions: [] } }],
    };
    expect(await web.engine.auditAgentAction(action, narrowed)).toMatchObject({
      verdict: "not_allowed",
      reason: "permission",
    });
    const foreign = {
      ...listed,
      scopes: [
        {
          ...first,
          signed: {
            ...first.signed,
            envelope: { ...first.signed.envelope, tokenId: newId("tok") },
          },
        },
      ],
    };
    expect(await web.engine.auditAgentAction(action, foreign)).toEqual({
      verdict: "unchecked",
      reason: "other_token",
    });
  });

  it("judges every touched folder's mode under the policy revision the action named", async () => {
    const { world, web, cli, home, noteId, scopeRevision } = await seeded(["notes.delete"]);
    const other = await folder(world, web, "Other");
    const policy = await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: other, mode: "review" }],
      baseRevision: 0,
    });
    expect(policy.status).toBe("saved");
    await cli.engine.pull();
    expect((await cli.engine.deleteAsAgent({ noteId, baseVersion: 1, scopeRevision })).status).toBe(
      "saved",
    );
    await web.engine.pull();
    const [action] = await web.engine.agentActions({ sinceMs: 60_000 });
    if (action === undefined) throw new Error("no action");
    const scopes = await fetchTokenScopes(sessionApi(world), {
      ownerSigningPublicKey: world.account.signing.publicKey,
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
    });
    expect(await web.engine.auditAgentAction(action, scopes)).toMatchObject({
      verdict: "allowed",
      policy: { revision: 1, mode: "direct" },
    });
    // in a tree where Home sits under the folder that asks first, the delete wasn't allowed
    const folders = (id: string) =>
      id === home
        ? { parentId: other, deleted: false }
        : id === other
          ? { parentId: null, deleted: false }
          : undefined;
    expect(await web.engine.auditAgentAction(action, scopes, { folders })).toMatchObject({
      verdict: "not_allowed",
      reason: "policy",
      policy: { mode: "review" },
    });
  });
});

describe("the root folder marker", () => {
  it("is set once, and the engine reads it from the feed", async () => {
    const world = new World();
    const web = world.web();
    const root = await folder(world, web, "");
    await web.api.call(routes.setRootFolder, {
      params: { workspaceId: world.workspaceId },
      body: { folderId: root },
    });
    await expect(
      web.api.call(routes.setRootFolder, {
        params: { workspaceId: world.workspaceId },
        body: { folderId: root },
      }),
    ).rejects.toSatisfy((error) => isSyncApiError(error, "already_exists"));
    const cli = world.cli();
    expect(cli.engine.rootFolderId).toBeNull();
    await cli.engine.pull();
    expect(cli.engine.rootFolderId).toBe(root);
  });
});
