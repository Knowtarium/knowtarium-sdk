import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ready, toBase64Url } from "../../crypto/index.js";
import {
  type AgentPermission,
  agentScopeSha256,
  type FolderId,
  type PendingId,
  PROTOCOL_HEADER,
  routes,
} from "../../protocol/index.js";
import {
  EncryptedCache,
  encryptAgentName,
  MemoryTrustStorage,
  newId,
  prepareConnectScope,
  prepareFolder,
  TrustState,
} from "../../client/index.js";
import { fakeSockets } from "../../client/testing/fake-socket.js";
import { flush } from "../../client/testing/http.js";
import { World } from "../../client/testing/world.js";
import { FileCacheAdapter } from "../storage/file-cache.js";
import type { AgentScopeFloor, Connection, ScopeFloorStore } from "../storage/credentials.js";
import { temporaryFolder } from "../testing/context.js";
import { GuardedCacheAdapter } from "./guarded-cache.js";
import { createKnowtariumServer } from "./server.js";
import { WorkspaceSession } from "./session.js";
import { FOLDER_CHANGES_ASK_FIRST } from "./tools/organize.js";

beforeAll(ready);

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const note = (title: string) =>
  `---\ntype: Note\ntitle: ${title}\ngenerated: { by: claude-code/2.0, at: 2026-09-01T10:00:00Z }\n---\n${title} body.\n`;

const ORGANIZE = [
  "create_folder",
  "delete_folder",
  "delete_note",
  "move_folder",
  "move_note",
  "rename_folder",
];

/** A workspace with two folders (Research, Archive) and a note in Research. */
async function seeded() {
  const world = new World();
  const web = world.web();
  const folder = async (name: string, parentId: FolderId | null = null): Promise<FolderId> => {
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
  };
  const research = await folder("Research");
  const archive = await folder("Archive");
  const pricing = newId("note");
  await web.engine.writeNote({
    noteId: pricing,
    folderId: research,
    baseVersion: 0,
    name: "pricing.md",
    text: note("Pricing"),
  });
  return { world, web, folder, research, archive, pricing };
}

/** A scope floor kept in memory, as `agent-scopes.enc` keeps it. */
function memoryFloors(): ScopeFloorStore & { floors: AgentScopeFloor[] } {
  const floors: AgentScopeFloor[] = [];
  return {
    floors,
    scopeFloor: (workspaceId, tokenId) =>
      Promise.resolve(
        floors
          .filter((floor) => floor.workspaceId === workspaceId && floor.tokenId === tokenId)
          .at(-1),
      ),
    putScopeFloor: (floor) => {
      floors.push(floor);
      return Promise.resolve();
    },
  };
}

/** The CLI side over a connection saved at connect, an MCP server and a client. */
async function connect(
  world: World,
  options: {
    access?: "read" | "read-write";
    folderIds?: FolderId[];
    scopes?: ScopeFloorStore;
  } = {},
) {
  const dir = await temporaryFolder();
  cleanups.push(dir.cleanup);
  const connection: Connection = {
    apiUrl: "https://api.test",
    workspaceId: world.workspaceId,
    tokenId: world.tokenId,
    tokenSecret: world.agentToken,
    access: options.access ?? "read-write",
    folderIds: options.folderIds ?? [],
    agentPrivateKey: toBase64Url(world.agent.privateKey),
    ownerId: world.accountId,
    ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
    connectedAt: new Date().toISOString(),
    agentSignPrivateKey: toBase64Url(world.agentSigning.privateKey),
  };
  const [vouched] = world.server.agentKeyRecords;
  if (vouched !== undefined) connection.agentKey = vouched.signed;
  const adapter = new GuardedCacheAdapter(new FileCacheAdapter(dir.path));
  const session = await WorkspaceSession.open(connection, {
    fetch: world.server.fetch,
    trust: new TrustState(new MemoryTrustStorage()),
    cache: new EncryptedCache(adapter),
    adapter,
    log: () => undefined,
    actor: () => "claude-code/2.1.0",
    retryAfterMs: 3_600_000,
    apiRetry: { maxAttempts: 1 },
    ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
  });
  await session.start();
  cleanups.push(() => {
    session.stop();
    return Promise.resolve();
  });
  const server = createKnowtariumServer([session], { version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  let listChanged = 0;
  client.fallbackNotificationHandler = (notification) => {
    if (notification.method === "notifications/tools/list_changed") listChanged++;
    return Promise.resolve();
  };
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as { type: string; text: string }[];
    return {
      error: result.isError === true,
      text: content?.text ?? "",
      json: () => JSON.parse(content?.text ?? "null") as Record<string, unknown>,
    };
  };
  const tools = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return { session, client, call, tools, listChanged: () => listChanged };
}

/** The owner changes the agent's scope in the web app, and the agent reads it again. */
async function grant(
  world: World,
  session: WorkspaceSession,
  permissions: readonly AgentPermission[],
  scope: { access?: "read" | "read-write"; folderIds?: FolderId[] } = {},
) {
  const result = await world.grantScope({ permissions, ...scope });
  expect(result.status).toBe("saved");
  await session.refreshScope({ pull: true });
}

describe("organizing tools", () => {
  it("lists each tool only while the verified scope holds its permission, and says so", async () => {
    const { world } = await seeded();
    const { session, tools, call, listChanged } = await connect(world);
    expect((await tools()).filter((name) => ORGANIZE.includes(name))).toEqual([]);
    const [before] = (await call("list_workspaces")).json() as unknown as Record<string, unknown>[];
    expect(before).toMatchObject({ permissions: [], scopeRevision: 0, scopeVerified: false });
    const notified = listChanged();
    await grant(world, session, ["notes.delete", "folders.create"]);
    expect((await tools()).filter((name) => ORGANIZE.includes(name)).sort()).toEqual([
      "create_folder",
      "delete_note",
    ]);
    // one notification for the change, however many tools it switched
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(listChanged()).toBe(notified + 1);
    const [after] = (await call("list_workspaces")).json() as unknown as Record<string, unknown>[];
    expect(after).toMatchObject({
      permissions: ["notes.delete", "folders.create"],
      scopeRevision: 1,
      scopeVerified: true,
    });
    // taken away again
    await grant(world, session, []);
    expect((await tools()).filter((name) => ORGANIZE.includes(name))).toEqual([]);
  });

  it("shows today's writing tools when a read token becomes read-write, and hides them again", async () => {
    const { world } = await seeded();
    world.server.agentAccess = "read";
    const { session, tools } = await connect(world, { access: "read" });
    expect(await tools()).not.toContain("propose_edit");
    await grant(world, session, [], { access: "read-write" });
    expect(await tools()).toContain("propose_edit");
    expect(await tools()).toContain("create_note");
    await grant(world, session, [], { access: "read" });
    expect(await tools()).not.toContain("propose_edit");
  });

  it("refuses a scope the owner didn't sign, keeping the one it verified", async () => {
    const { world } = await seeded();
    const floors = memoryFloors();
    const { session } = await connect(world, { scopes: floors });
    await grant(world, session, ["notes.delete"]);
    expect(floors.floors.map((floor) => floor.revision)).toEqual([1]);
    // a server serving an older scope, or none, after one was verified: a rollback
    const signed = world.server.agentScopes.splice(0);
    world.server.scopeRevision = 0;
    await session.refreshScope();
    expect(session.scope).toMatchObject({ revision: 1, problem: "rollback" });
    expect(session.allows("notes.delete")).toBe(true);
    world.server.agentScopes.push(...signed);
    world.server.scopeRevision = 1;
    // a restart picks the floor up from agent-scopes.enc, verified again
    const again = await connect(world, { scopes: floors });
    expect(again.session.scope).toMatchObject({ revision: 1, verified: true });
  });

  it("drops the local copy and pulls again only when access or folders change", async () => {
    const { world, research, archive } = await seeded();
    const { session } = await connect(world, { folderIds: [research] });
    world.server.agentFolderIds = [research];
    await session.sync();
    const fromZero = () =>
      world.server.requests.filter((request) => request.url.includes("/changes?since=0&")).length;
    const pulls = fromZero();
    // a permission alone: no pull from 0
    await grant(world, session, ["notes.delete"], { folderIds: [research] });
    expect(fromZero()).toBe(pulls);
    // another folder: the copy goes and comes back from 0, with the folder newly in scope
    const archived = newId("note");
    await world.web().engine.writeNote({
      noteId: archived,
      folderId: archive,
      baseVersion: 0,
      name: "old.md",
      text: note("Old"),
    });
    await grant(world, session, ["notes.delete"], { folderIds: [research, archive] });
    expect(fromZero()).toBe(pulls + 1);
    expect(session.view.notes.has(archived)).toBe(true);
    expect(session.scope.folderIds).toEqual([research, archive]);
  });

  it("takes the permissions the owner signed at connect, and refuses unsigned ones", async () => {
    const { world, web } = await seeded();
    const bytes = (length: number, fill: number) => toBase64Url(new Uint8Array(length).fill(fill));
    const approval = {
      tokenId: world.tokenId,
      tokenSecretSha256: bytes(32, 1),
      workspaceId: world.workspaceId,
      access: "read-write" as const,
      folderIds: [],
      encName: encryptAgentName(
        world.key,
        { workspaceId: world.workspaceId, tokenId: world.tokenId },
        "Claude",
      ),
      publicKey: toBase64Url(world.agent.publicKey),
      keyGeneration: 1,
      encWorkspaceKey: bytes(80, 2),
      signedAt: new Date().toISOString(),
      signature: bytes(64, 3),
      keyCommitment: "c".repeat(64),
      generationSignedAt: new Date().toISOString(),
      generationSignature: bytes(64, 4),
    };
    const scope = await prepareConnectScope(world.signer, {
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      access: "read-write",
      folderIds: [],
      permissions: ["notes.delete", "folders.create"],
    });
    // permissions without the owner's signed scope are refused
    await expect(
      web.api.call(routes.approveConnect, {
        params: { requestId: newId("cr") },
        body: { ...approval, permissions: ["notes.delete"] },
      }),
    ).rejects.toThrow();
    // a forged scope signature is refused
    await expect(
      web.api.call(routes.approveConnect, {
        params: { requestId: newId("cr") },
        body: { ...approval, ...scope, scopeSignature: bytes(64, 9) },
      }),
    ).rejects.toThrow();
    const { data } = await web.api.call(routes.approveConnect, {
      params: { requestId: newId("cr") },
      body: { ...approval, ...scope },
    });
    expect(data.token).toMatchObject({
      scopeRevision: 1,
      permissions: ["notes.delete", "folders.create"],
    });
    const { session, tools } = await connect(world);
    expect(session.scope).toMatchObject({ revision: 1, verified: true });
    expect((await tools()).filter((name) => ORGANIZE.includes(name)).sort()).toEqual([
      "create_folder",
      "delete_note",
    ]);
  });

  it("follows a live scope_changed ping: reads the token again and switches the tools", async () => {
    const { world } = await seeded();
    const { session, tools, listChanged } = await connect(world);
    const { connect: sockets, sockets: opened } = fakeSockets();
    session.goLive(sockets);
    for (let i = 0; i < 50 && opened.length === 0; i++) await flush();
    expect((await tools()).filter((name) => ORGANIZE.includes(name))).toEqual([]);
    const before = listChanged();
    // the server pings the token's sockets when the owner changes its scope
    world.server.onScopeChanged = (revision) => {
      opened[0]?.receive({ type: "scope_changed", revision });
    };
    await world.grantScope({ permissions: ["notes.delete"] });
    for (let i = 0; i < 100 && !session.allows("notes.delete"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await tools()).toContain("delete_note");
    expect(listChanged()).toBeGreaterThan(before);
  });

  it("reads the scope again on a stale close and on every reconnect, missing no change", async () => {
    const { world, research } = await seeded();
    const { session } = await connect(world);
    const { connect: sockets, sockets: opened } = fakeSockets();
    session.goLive(sockets);
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await until(() => opened.length > 0);
    const hello = { type: "hello", protocolVersion: 3, workspaceVersion: world.server.seq };
    opened[0]?.receive(hello);
    // a first change, pinged and closed stale (4000); a second right after, with no ping of its
    // own: the close and the reconnect's hello read the scope again
    await world.grantScope({ permissions: ["notes.delete"] });
    opened[0]?.receive({ type: "scope_changed", revision: 1 });
    opened[0]?.drop(4000);
    await world.grantScope({ permissions: ["notes.delete"], folderIds: [research] });
    await until(() => opened.length > 1);
    opened[1]?.receive(hello);
    await until(() => session.scope.revision === 2 && session.loaded);
    expect(session.scope).toMatchObject({ revision: 2, folderIds: [research] });
    // asleep: the socket drops, the owner narrows the scope meanwhile, the next hello catches it
    opened[1]?.drop(1006);
    await world.grantScope({ permissions: [], folderIds: [research] });
    await until(() => opened.length > 2);
    opened[2]?.receive(hello);
    await until(() => session.scope.revision === 3);
    expect(session.allows("notes.delete")).toBe(false);
    // the narrowed copy holds only what is in scope
    expect([...session.view.folders.keys()]).toEqual([research]);
  }, 20_000);

  it("keeps the tools hidden when the server widens a scope the owner didn't sign", async () => {
    const { world } = await seeded();
    const { session, tools } = await connect(world);
    await grant(world, session, []);
    const [signed] = world.server.agentScopes;
    if (signed === undefined) throw new Error("no scope");
    const widened = {
      access: "read-write" as const,
      folderIds: [],
      permissions: ["notes.delete" as const, "folders.delete" as const],
    };
    // the owner's revision 1 with a wider scope beside it: the hash no longer matches
    world.server.agentScopes.splice(0, 1, { ...signed, scope: widened });
    world.server.agentPermissions = [...widened.permissions];
    await session.refreshScope();
    expect(session.scope).toMatchObject({ revision: 1, problem: "hash_mismatch" });
    // a revision 2 the owner never signed: the signature doesn't verify
    const scopeSha256 = await agentScopeSha256(widened);
    world.server.agentScopes.splice(0, 1, signed, {
      envelope: { ...signed.envelope, revision: 2, scopeSha256 },
      signature: signed.signature,
      scope: widened,
    });
    world.server.scopeRevision = 2;
    await session.refreshScope();
    expect(session.scope).toMatchObject({ revision: 1, problem: "bad_signature" });
    expect(session.permissions).toEqual([]);
    expect((await tools()).filter((name) => ORGANIZE.includes(name))).toEqual([]);
  });

  it("reads once more when the scope changes during a read, and pulls if a caller asked", async () => {
    const { world, research, archive } = await seeded();
    const { session } = await connect(world);
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    world.server.tamper.hold = (route) => (route === "getCurrentToken" ? gate : undefined);
    const first = session.refreshScope();
    await flush();
    // meanwhile the owner narrows the folders, and a ping asks for a refresh with a pull
    await world.grantScope({ permissions: ["notes.delete"], folderIds: [research] });
    const second = session.refreshScope({ pull: true });
    delete world.server.tamper.hold;
    open();
    await Promise.all([first, second]);
    expect(session.scope).toMatchObject({ revision: 1, folderIds: [research] });
    expect(session.allows("notes.delete")).toBe(true);
    // the copy was read again for the narrowed scope
    expect(session.loaded).toBe(true);
    expect([...session.view.folders.keys()]).not.toContain(archive);
  });

  it("reads the token again and retries a write refused for a scope that moved on in flight", async () => {
    const { world } = await seeded();
    const { session, call } = await connect(world);
    await grant(world, session, ["notes.delete"]);
    // one request authenticated before the owner's change: refused, then read again and retried
    let stale = 1;
    world.server.tamper.principalScopeRevision = () => (stale-- > 0 ? 0 : undefined);
    const answer = await call("delete_note", { note: "Research/pricing.md", base_version: 1 });
    expect(answer.json()).toMatchObject({ mode: "written" });
  });

  it("sends protocol 3 on every request", async () => {
    const { world } = await seeded();
    await connect(world);
    const versions = new Set(
      world.server.requests.map((request) => request.init.headers[PROTOCOL_HEADER]),
    );
    expect([...versions]).toEqual(["3"]);
  });
});

describe("delete_note and move_note", () => {
  it("deletes a note directly, with the summary in the agent's record", async () => {
    const { world, pricing } = await seeded();
    const { session, call } = await connect(world);
    await grant(world, session, ["notes.delete"]);
    const answer = await call("delete_note", {
      note: "Research/pricing.md",
      base_version: 1,
      summary: "Superseded by the price list",
    });
    expect(answer.error).toBe(false);
    expect(answer.json()).toMatchObject({ mode: "written", noteId: pricing, version: 2 });
    expect(world.server.notes.get(pricing)?.versions.at(-1)?.deleted).toBe(true);
    expect(session.view.notes.has(pricing)).toBe(false);
    const wrote = world.server.events.filter(
      (event) => event.noteId === pricing && event.ciphertext !== null,
    );
    expect(wrote).toHaveLength(1);
  });

  it("proposes the delete where the folder asks first", async () => {
    const { world, web, research, pricing } = await seeded();
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: research, mode: "review" }],
      baseRevision: 0,
    });
    const { session, call } = await connect(world);
    await grant(world, session, ["notes.delete"]);
    const answer = await call("delete_note", { note: "Research/pricing.md", base_version: 1 });
    expect(answer.json()).toMatchObject({ mode: "proposed", noteId: pricing });
    expect(answer.text).toContain("asks for the person's approval");
    expect([...world.server.pending.values()].map((entry) => entry.change.kind)).toEqual([
      "delete",
    ]);
  });

  it("refuses without the permission, outside the scope, and on a stale base", async () => {
    const { world, research, archive } = await seeded();
    const { session, call } = await connect(world, { folderIds: [archive] });
    world.server.agentFolderIds = [archive];
    // the tool isn't listed; called anyway, the client is refused
    const hidden = await call("delete_note", { note: "Research/pricing.md", base_version: 1 });
    expect(hidden.error).toBe(true);
    await grant(world, session, ["notes.delete"], { folderIds: [archive] });
    const outside = await call("delete_note", { note: "Research/pricing.md", base_version: 1 });
    expect(outside.error).toBe(true);
    expect(outside.text).toMatch(/No note/);
    expect(research).not.toBe(archive);
  });

  it("moves a note directly with its text unchanged, and needs notes.move", async () => {
    const { world, pricing } = await seeded();
    const { session, call, tools } = await connect(world);
    expect(await tools()).not.toContain("move_note");
    await grant(world, session, ["notes.move"]);
    const answer = await call("move_note", {
      note: "Research/pricing.md",
      folder: "Archive",
      base_version: 1,
    });
    expect(answer.json()).toMatchObject({ mode: "written", path: "Archive/pricing.md" });
    expect(session.view.notes.get(pricing)?.text).toBe(note("Pricing"));
    const same = await call("move_note", {
      note: "Archive/pricing.md",
      folder: "Archive",
      base_version: 2,
    });
    expect(same.error).toBe(true);
  });

  it("proposes a move out of a folder that asks first", async () => {
    const { world, web, research } = await seeded();
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: research, mode: "review" }],
      baseRevision: 0,
    });
    const { session, call } = await connect(world);
    await grant(world, session, ["notes.move"]);
    const answer = await call("move_note", {
      note: "Research/pricing.md",
      folder: "Archive",
      base_version: 1,
      summary: "Belongs with the archive",
    });
    expect(answer.json()).toMatchObject({ mode: "proposed" });
    // the agent sees it as a move, with both folders
    const mine = (await call("my_pending_changes")).json() as { changes: unknown[] };
    expect(mine.changes).toMatchObject([
      { kind: "move", from: "Research", to: "Archive", summary: "Belongs with the archive" },
    ]);
    // once the person approved it, it is still a move
    const pendingId = (answer.json() as { pendingId: PendingId }).pendingId;
    const review = await web.engine.readPending(pendingId);
    const approved = await web.engine.approvePending(
      review.pending,
      { name: review.proposedName ?? "pricing.md", text: review.proposed },
      { takenNames: [] },
    );
    expect(approved.status).toBe("approved");
    await session.sync();
    const after = (await call("my_pending_changes")).json() as { changes: unknown[] };
    expect(after.changes).toMatchObject([
      { kind: "move", status: "approved", from: "Research", to: "Archive" },
    ]);
  });

  it("reads the token again and retries once when its scope moved on in between", async () => {
    const { world, pricing } = await seeded();
    const { session, call } = await connect(world);
    await grant(world, session, ["notes.delete"]);
    // the owner changes the scope again; the session hasn't seen it yet
    await world.grantScope({ permissions: ["notes.delete", "notes.move"] });
    expect(session.scope.revision).toBe(1);
    const answer = await call("delete_note", { note: "Research/pricing.md", base_version: 1 });
    expect(answer.json()).toMatchObject({ mode: "written", noteId: pricing });
    expect(session.scope.revision).toBe(2);
  });
});

describe("folder tools", () => {
  const all: AgentPermission[] = [
    "folders.create",
    "folders.rename",
    "folders.move",
    "folders.delete",
  ];

  it("creates, renames, moves and deletes a folder directly", async () => {
    const { world } = await seeded();
    const { session, call } = await connect(world);
    await grant(world, session, all);
    const created = await call("create_folder", { parent: "Research", name: "Drafts" });
    expect(created.json()).toMatchObject({ mode: "written", path: "Research/Drafts" });
    const twice = await call("create_folder", { parent: "Research", name: "drafts" });
    expect(twice.error).toBe(true);
    expect(twice.text).toMatch(/already/);
    expect(
      (await call("rename_folder", { folder: "Research/Drafts", name: "Old drafts" })).json(),
    ).toMatchObject({ path: "Research/Old drafts" });
    expect(
      (await call("move_folder", { folder: "Research/Old drafts", parent: "Archive" })).json(),
    ).toMatchObject({ path: "Archive/Old drafts" });
    expect(
      (await call("move_folder", { folder: "Archive", parent: "Archive/Old drafts" })).error,
    ).toBe(true);
    expect((await call("delete_folder", { folder: "Archive/Old drafts" })).json()).toMatchObject({
      mode: "written",
    });
    const notEmpty = await call("delete_folder", { folder: "Research" });
    expect(notEmpty.error).toBe(true);
    expect(notEmpty.text).toMatch(/isn't empty/);
  });

  it("refuses its own scope folders, the root folder, and the top level for a scoped token", async () => {
    const { world, web, folder, research } = await seeded();
    const root = await folder("");
    await web.api.call(routes.setRootFolder, {
      params: { workspaceId: world.workspaceId },
      body: { folderId: root },
    });
    const whole = await connect(world);
    await grant(world, whole.session, all);
    const rootRename = await whole.call("rename_folder", { folder: root, name: "Top" });
    expect(rootRename.error).toBe(true);
    expect(rootRename.text).toMatch(/root folder/);

    const scoped = await connect(world, { folderIds: [research] });
    await grant(world, scoped.session, all, { folderIds: [research] });
    const own = await scoped.call("rename_folder", { folder: "Research", name: "Mine" });
    expect(own.error).toBe(true);
    expect(own.text).toMatch(/folders this agent was given/);
    const top = await scoped.call("create_folder", { parent: "", name: "New" });
    expect(top.error).toBe(true);
    expect(top.text).toMatch(/top level/);
    // inside its scope it may make one
    expect((await scoped.call("create_folder", { parent: "Research", name: "Sub" })).error).toBe(
      false,
    );
  });

  it("refuses a folder change where the folder asks first, saying to tell the person", async () => {
    const { world, web } = await seeded();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    const { session, call } = await connect(world);
    await grant(world, session, all);
    const answer = await call("create_folder", { parent: "Research", name: "Drafts" });
    expect(answer.error).toBe(true);
    expect(answer.text).toBe(FOLDER_CHANGES_ASK_FIRST);
  });

  it("refuses folders outside its scope, and the inbox for a delete", async () => {
    const { world, web, folder, research } = await seeded();
    const inbox = await folder("Inbox");
    const { inboxKey } = await web.engine.ensureInboxKey({ folderId: inbox });
    expect(inboxKey).not.toBeNull();
    const whole = await connect(world);
    await grant(world, whole.session, all);
    // the session reads the inbox key with its filing pass
    await whole.session.fileClips();
    expect(whole.session.inboxFolderId).toBe(inbox);
    const inboxDelete = await whole.call("delete_folder", { folder: "Inbox" });
    expect(inboxDelete.error).toBe(true);
    expect(inboxDelete.text).toMatch(/inbox/);
    // renaming the inbox is allowed (the clipper follows its ID)
    expect((await whole.call("rename_folder", { folder: "Inbox", name: "Saved" })).error).toBe(
      false,
    );
    const scoped = await connect(world, { folderIds: [research] });
    await grant(world, scoped.session, all, { folderIds: [research] });
    for (const [tool, args] of [
      ["rename_folder", { folder: "Archive", name: "Old" }],
      ["move_folder", { folder: "Archive", parent: "Research" }],
      ["delete_folder", { folder: "Archive" }],
      ["create_folder", { parent: "Archive", name: "New" }],
    ] as const) {
      const answer = await scoped.call(tool, args);
      expect(answer.error, tool).toBe(true);
      expect(answer.text, tool).toMatch(/among the folders this agent may use/);
    }
  });

  it("explains another agent's protected folder", async () => {
    const { world, archive, research } = await seeded();
    const { session, call } = await connect(world);
    await grant(world, session, all);
    world.server.otherScopeFolderIds = [archive];
    const answer = await call("rename_folder", { folder: "Archive", name: "Old" });
    expect(answer.error).toBe(true);
    expect(answer.text).toMatch(/one a connected agent was given.*can't rename or move/);
    // a protected folder that holds notes: protected first, never "empty it"
    world.server.otherScopeFolderIds = [research];
    const deleting = await call("delete_folder", { folder: "Research" });
    expect(deleting.error).toBe(true);
    expect(deleting.text).toMatch(/Keep it, and keep its notes/);
    expect(deleting.text).not.toMatch(/isn't empty/);
  });

  it("points create_note at create_folder when the agent may make folders", async () => {
    const { world } = await seeded();
    const { session, call } = await connect(world);
    const without = await call("create_note", { folder: "Nowhere", title: "X", text: "x" });
    expect(without.text).toMatch(/can't create folders/);
    await grant(world, session, ["folders.create"]);
    const with_ = await call("create_note", { folder: "Nowhere", title: "X", text: "x" });
    expect(with_.text).toMatch(/create_folder/);
  });
});
