import { beforeAll, describe, expect, it } from "vitest";

import {
  createAccountKeys,
  createAgentSigningKeyPair,
  encryptText,
  ready,
  type SignedEnvelopeFields,
  signEnvelope,
} from "../../crypto/index.js";
import { utf8Decode, utf8Encode } from "../../crypto/encoding.js";
import type { AgentKeyRecord, FolderId, NoteId } from "../../protocol/index.js";
import {
  agentPolicyFolderHash,
  MISSING_AGENT_POLICY_SHA256,
  missingAgentPolicy,
  type NoteEvent,
  routes,
} from "../../protocol/index.js";
import { EncryptedCache, MemoryCacheAdapter } from "../cache/index.js";
import { deriveVerification, parseNote } from "../../core/index.js";
import { isSyncApiError, isVaultError, RequestValidationError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { fakeSockets } from "../testing/fake-socket.js";
import { flush } from "../testing/http.js";
import { type Client, World } from "../testing/world.js";
import {
  createKeyProvider,
  encryptCheck,
  fetchAgentPolicy,
  MemoryTrustStorage,
  rotateWorkspace,
  TrustState,
  prepareFolder,
  prepareWorkspace,
  requireVerifiedPolicy,
  signAgentEdited,
  signAgentKey,
  signEdited,
  signingHeaders,
  signRevocation,
} from "../vault/index.js";
import { AgentKeyDirectory } from "./agent-keys.js";
import type { NoteSnapshot, SyncEvent } from "./events.js";

beforeAll(ready);

/** Any server time (the snapshot's `createdAt`). */
const anyTime = expect.any(String) as unknown as string;

const MARKER = "PLAINTEXT-MARKER-7f3a";

function note(body: string): string {
  return `---\ntitle: ${MARKER} title\ntype: concept\n---\n${body} ${MARKER}\n`;
}

function record(client: Client): SyncEvent[] {
  const events: SyncEvent[] = [];
  client.engine.subscribe((event) => events.push(event));
  return events;
}

function notesIn(events: SyncEvent[]) {
  return events.flatMap((event) => (event.type === "note" ? [event.note] : []));
}

function errorsIn(events: SyncEvent[]) {
  return events.flatMap((event) => (event.type === "error" ? [event.error] : []));
}

describe("sync engine", () => {
  it("syncs a person's edit to the agent, verified and decrypted", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");

    const saved = await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("first"),
    });
    expect(saved).toMatchObject({ status: "saved", note: { version: 1 } });

    const seen = record(cli);
    const cursor = await cli.engine.pull();
    expect(cursor).toBe(world.server.seq);
    expect(notesIn(seen)).toMatchObject([
      {
        noteId,
        folderId: world.folderId,
        version: 1,
        name: "note.md",
        text: note("first"),
        createdAt: anyTime,
      },
    ]);
    expect(seen).toContainEqual({ type: "workspace", name: "Clients", keyGeneration: 1 });
    expect(seen.at(-1)).toEqual({ type: "synced", cursor });
    expect(errorsIn(seen)).toEqual([]);
  });

  it("pulls only what changed since the cursor", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const a: NoteId = newId("note");
    const b: NoteId = newId("note");
    await web.engine.writeNote({
      noteId: a,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "a",
    });
    await cli.engine.pull();
    await web.engine.writeNote({
      noteId: b,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "b",
    });
    const seen = record(cli);
    await cli.engine.pull();
    expect(notesIn(seen).map((entry) => entry.text)).toEqual(["b"]);
  });

  it("returns both versions on a 409 for the merge UI", async () => {
    const world = new World();
    const laptop = world.web();
    const phone = world.web();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;
    await laptop.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: "from the laptop",
    });
    const result = await phone.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: "from the phone",
    });
    expect(result).toMatchObject({
      status: "conflict",
      mine: { baseVersion: 0, name: "note.md", text: "from the phone" },
      theirs: {
        noteId,
        folderId,
        version: 1,
        name: "note.md",
        text: "from the laptop",
        createdAt: anyTime,
      },
    });
    const merged = await phone.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: "merged",
    });
    expect(merged).toMatchObject({ status: "saved", note: { version: 2, text: "merged" } });
  });

  it("carries an agent's proposal through review and approval", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("v1"),
    });

    const submitted = await cli.engine.submitPending({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: note("proposed"),
    });
    if (submitted.status !== "submitted") throw new Error("expected a submission");

    const seen = record(web);
    await web.engine.pull();
    const changes = seen.flatMap((event) => (event.type === "change" ? [event.change] : []));
    expect(changes).toMatchObject([{ kind: "pending", pendingId: submitted.pending.id }]);

    const review = await web.engine.readPending(submitted.pending.id);
    expect(review.proposed).toBe(note("proposed"));
    expect(review.base).toMatchObject({ version: 1, text: note("v1") });

    const approvedText = `${review.proposed}verified: human\n`;
    // the signed approval's time is the caller's, so the text can name it too
    const signedAt = new Date(Date.now() - 60_000).toISOString();
    const approved = await web.engine.approvePending(
      review.pending,
      { name: "note.md", text: approvedText },
      { takenNames: [], signedAt },
    );
    expect(world.server.events.at(-1)?.signed?.envelope).toMatchObject({
      type: "approved",
      createdAt: signedAt,
    });
    expect(approved).toMatchObject({
      status: "approved",
      pending: { status: "approved", resultingVersion: 2 },
      note: { version: 2, text: approvedText },
    });

    const agentSeen = record(cli);
    await cli.engine.pull();
    expect(notesIn(agentSeen)).toMatchObject([{ version: 2, text: approvedText }]);
    expect(errorsIn(agentSeen)).toEqual([]);
  });

  it("shows an approval conflict when the note moved on", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;
    await web.engine.writeNote({ noteId, folderId, baseVersion: 0, name: "note.md", text: "v1" });
    const submitted = await cli.engine.submitPending({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: "agent",
    });
    if (submitted.status !== "submitted") throw new Error("expected a submission");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: "person",
    });
    const result = await web.engine.approvePending(
      submitted.pending,
      { name: "note.md", text: "agent, approved" },
      { takenNames: [] },
    );
    expect(result).toMatchObject({
      status: "conflict",
      mine: { baseVersion: 1, name: "note.md", text: "agent, approved" },
      theirs: {
        noteId,
        folderId,
        version: 2,
        name: "note.md",
        text: "person",
        createdAt: anyTime,
      },
    });
  });

  it("rejects with a signed, encrypted comment", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    const submitted = await cli.engine.submitPending({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "a new note",
    });
    if (submitted.status !== "submitted") throw new Error("expected a submission");
    const rejected = await web.engine.rejectPending(submitted.pending, {
      author: `human:${world.accountId}`,
      text: `Not this one ${MARKER}`,
    });
    expect(rejected.pending).toMatchObject({
      status: "rejected",
      rejectionCommentId: rejected.comment.id,
    });
    expect(world.server.comments).toHaveLength(1);
  });

  it("syncs a signed delete", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "x",
    });
    await cli.engine.pull();
    const deleted = await web.engine.deleteNote({ noteId, baseVersion: 1 });
    expect(deleted).toMatchObject({ status: "saved", note: { version: 2, text: null } });
    const seen = record(cli);
    await cli.engine.pull();
    expect(notesIn(seen)).toMatchObject([
      {
        noteId,
        folderId: world.folderId,
        version: 2,
        name: null,
        text: null,
        createdAt: anyTime,
      },
    ]);
  });

  it("keeps each mode to its own routes", async () => {
    const world = new World();
    const noteId: NoteId = newId("note");
    const write = { noteId, folderId: world.folderId, baseVersion: 0, name: "x.md", text: "x" };
    await expect(world.cli().engine.writeNote(write)).rejects.toBeInstanceOf(
      RequestValidationError,
    );
    await expect(world.web().engine.submitPending(write)).rejects.toBeInstanceOf(
      RequestValidationError,
    );
  });
});

describe("integrity", () => {
  it("refuses an older note version than one seen", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;
    await web.engine.writeNote({ noteId, folderId, baseVersion: 0, name: "note.md", text: "v1" });
    await web.engine.writeNote({ noteId, folderId, baseVersion: 1, name: "note.md", text: "v2" });
    await cli.engine.pull();
    expect(await cli.trust.noteVersion(world.workspaceId, noteId)).toBe(2);

    // the server rolls the note back to version 1 and replays it in the feed
    const fresh = world.cli({ trust: cli.trust });
    world.server.tamper.feed = (changes) =>
      changes.map((change) =>
        change.kind === "note" ? { ...change, version: 1, seq: change.seq } : change,
      );
    const seen = record(fresh);
    await fresh.engine.pull();
    expect(notesIn(seen)).toEqual([]);
    const [error] = errorsIn(seen);
    expect(isVaultError(error, "rollback")).toBe(true);
  });

  it("refuses a version whose bytes don't match the signed hash", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "real",
    });
    // a blob the server made with a key it learned: well-formed, but not what the person signed
    world.server.tamper.versionBlob = () =>
      encryptText(world.key, "planted", {
        kind: "note",
        workspaceId: world.workspaceId,
        id: noteId,
      });
    const cli = world.cli();
    const seen = record(cli);
    await cli.engine.pull();
    expect(notesIn(seen)).toEqual([]);
    expect(isVaultError(errorsIn(seen)[0], "untrusted_signature")).toBe(true);
  });

  it("refuses a version without its signed event", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "x",
    });
    world.server.tamper.events = () => [];
    const cli = world.cli();
    const seen = record(cli);
    await cli.engine.pull();
    expect(notesIn(seen)).toEqual([]);
    expect(isVaultError(errorsIn(seen)[0], "missing_signature")).toBe(true);
  });

  it("refuses a signature from another key", async () => {
    const world = new World();
    const noteId: NoteId = newId("note");
    await world.web().engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "x",
    });
    // a valid signature over the same envelope, by a key that isn't the owner's
    const intruder = createAccountKeys();
    world.server.tamper.events = (events) =>
      events.map((event) =>
        event.signed === null
          ? event
          : {
              ...event,
              signed: {
                envelope: event.signed.envelope,
                signature: signEnvelope(
                  event.signed.envelope as SignedEnvelopeFields,
                  intruder.signing,
                ).signature,
              },
            },
      );
    const cli = world.cli();
    const seen = record(cli);
    await cli.engine.pull();
    expect(notesIn(seen)).toEqual([]);
    expect(isVaultError(errorsIn(seen)[0], "untrusted_signature")).toBe(true);
  });
});

describe("encrypted cache", () => {
  it("stores only ciphertext and restores notes and the cursor", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("cached"),
    });
    const adapter = new MemoryCacheAdapter();
    const first = world.cli({ cache: new EncryptedCache(adapter) });
    const cursor = await first.engine.pull();

    for (const [key, value] of adapter.entries()) {
      expect(key).not.toContain(MARKER);
      expect(new TextDecoderLike().decode(value)).not.toContain(MARKER);
    }

    const requestsBefore = world.server.requests.length;
    const second = world.cli({ cache: new EncryptedCache(adapter) });
    const seen = record(second);
    await second.engine.load();
    expect(second.engine.cursor).toBe(cursor);
    expect(notesIn(seen)).toMatchObject([
      {
        noteId,
        folderId: world.folderId,
        version: 1,
        name: "note.md",
        text: note("cached"),
        createdAt: anyTime,
      },
    ]);
    // only the keys were fetched; the notes came from the cache
    const urls = world.server.requests.slice(requestsBefore).map((call) => call.url);
    expect(urls).toEqual(["https://api.test/keys"]);

    await second.engine.pull();
    const since = world.server.requests.slice(requestsBefore).map((call) => call.url);
    expect(since).toContain(
      `https://api.test/workspaces/${world.workspaceId}/changes?since=${String(cursor)}&limit=1000`,
    );
  });
});

describe("live", () => {
  it("pulls when a ping announces a newer version, over a ticket", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const { connect, sockets } = fakeSockets();
    const seen = record(cli);
    cli.engine.connectLive(connect);
    await flush();
    const [socket] = sockets;
    expect(socket?.url).toBe(
      `wss://api.test/workspaces/${world.workspaceId}/live?protocol=2&ticket=ktl_${"t".repeat(39)}1`,
    );
    socket?.receive({ type: "hello", protocolVersion: 1, workspaceVersion: world.server.seq });
    await flush();
    await cli.engine.pull();

    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "live",
    });
    socket?.receive({ type: "changed", workspaceVersion: world.server.seq });
    for (let i = 0; i < 10 && cli.engine.cursor < world.server.seq; i++) await flush();
    expect(notesIn(seen).map((entry) => entry.text)).toEqual(["live"]);
    expect(seen).toContainEqual({ type: "live", state: "open" });
    cli.engine.stop();
    expect(socket?.closed).toBe(true);
  });
});

describe("no plaintext on the wire", () => {
  it("sends only ciphertext, IDs and numbers", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;

    const workspace = prepareWorkspace(world.signer, {
      name: `${MARKER} workspace`,
      accountBoxPublicKey: world.account.encryption.publicKey,
    });
    await web.api.call(routes.createWorkspace, { body: workspace.request });
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("one"),
    });
    expect((await web.engine.readNote(noteId)).text).toBe(note("one"));
    await web.api.call(routes.createFolder, {
      params: { workspaceId: world.workspaceId },
      body: prepareFolder(world.signer, world.key, {
        workspaceId: world.workspaceId,
        parentId: null,
        name: `${MARKER} folder`,
        rootFolderId: null,
      }),
    });
    const proposal = await cli.engine.submitPending({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: note("agent"),
    });
    if (proposal.status !== "submitted") throw new Error("expected a submission");
    await web.engine.approvePending(
      proposal.pending,
      { name: "note.md", text: note("approved") },
      { takenNames: [] },
    );
    const second = await cli.engine.submitPending({
      noteId,
      folderId,
      baseVersion: 2,
      name: "note.md",
      text: note("again"),
    });
    if (second.status !== "submitted") throw new Error("expected a submission");
    await web.engine.rejectPending(second.pending, { text: `${MARKER} comment` });
    await web.engine.deleteNote({ noteId, baseVersion: 2 });
    await cli.engine.pull();
    await web.engine.pull();

    const marker = utf8Encode(MARKER);
    expect(world.server.requests.length).toBeGreaterThan(10);
    for (const { url, init } of world.server.requests) {
      expect(url).not.toContain(MARKER);
      expect(JSON.stringify(init.headers)).not.toContain(MARKER);
      const body =
        typeof init.body === "string" ? utf8Encode(init.body) : (init.body ?? new Uint8Array());
      expect(containsBytes(body, marker)).toBe(false);
    }
  });
});

/** Whether `needle` occurs in `haystack`. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Latin-1 decoding, so any bytes (ciphertext included) turn into a searchable string. */
class TextDecoderLike {
  decode(bytes: Uint8Array): string {
    return String.fromCharCode(...bytes);
  }
}

describe("the fake server's scopes", () => {
  it("serves an agent only its folders' subtrees and refuses the rest, like the sync API", async () => {
    const world = new World();
    const web = world.web();
    const folder = async (name: string, parentId: FolderId | null) => {
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
    const a = await folder("A", null);
    const inner = await folder("Inner", a);
    const b = await folder("B", null);
    const write = (folderId: FolderId, name: string) =>
      web.engine.writeNote({ noteId: newId("note"), folderId, baseVersion: 0, name, text: name });
    await write(a, "a.md");
    await write(inner, "inner.md");
    await write(b, "b.md");
    world.server.agentFolderIds = [a];
    const cli = world.cli();
    const seen: string[] = [];
    cli.engine.on("note", (event) => seen.push(event.note.name ?? ""));
    await cli.engine.pull();
    expect(seen.sort()).toEqual(["a.md", "inner.md"]);
    const outside = await cli.engine
      .submitPending({
        noteId: newId("note"),
        folderId: b,
        baseVersion: 0,
        name: "x.md",
        text: "x",
      })
      .catch((error: unknown) => error);
    expect(isSyncApiError(outside, "scope_denied")).toBe(true);
  });
});

describe("applying an agent's check", () => {
  it("signs the write as check_applied, marks the record applied, and confirms no person's entry", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "v1",
    });
    const checkId = newId("chk");
    await cli.api.call(routes.recordCheck, {
      params: { workspaceId: world.workspaceId },
      body: {
        id: checkId,
        noteId,
        noteVersion: 1,
        ciphertext: encryptCheck(
          world.key,
          { workspaceId: world.workspaceId, id: checkId },
          { actor: "claude-code/2.1", at: new Date().toISOString(), result: "pass", scope: [] },
        ).ciphertext,
      },
    });
    const applied = await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: "v1, checked",
      checkId,
    });
    if (applied.status !== "saved") throw new Error("expected the write to be saved");
    expect(applied.note.signedWrite).toBeNull();
    const last = world.server.events.at(-1)?.signed;
    expect(last?.envelope).toMatchObject({ type: "check_applied", checkId, version: 2 });
    expect(world.server.checks.find((check) => check.id === checkId)).toMatchObject({
      status: "applied",
      appliedVersion: 2,
    });
    // the agent accepts the version (a valid signed write) like any other
    const agentSeen = record(cli);
    await cli.engine.pull();
    expect(notesIn(agentSeen)).toMatchObject([{ version: 2, text: "v1, checked" }]);
    expect(cli.engine.quarantined).toEqual([]);
    // a check that isn't open can't be applied again
    const again = await web.engine
      .writeNote({
        noteId,
        folderId: world.folderId,
        baseVersion: 2,
        name: "note.md",
        text: "again",
        checkId,
      })
      .catch((error: unknown) => error);
    expect(isSyncApiError(again)).toBe(true);
  });
});

describe("confirmations across an applied check", () => {
  it("keeps the person's earlier signed write confirming their entry, in memory and from the cache", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    const owner = `human:${world.accountId}`;
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "---\ntype: Note\n---\nv1\n",
    });
    const at = new Date().toISOString();
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: `---\ntype: Note\nverified:\n  - { by: ${owner}, at: ${at} }\n---\nv2\n`,
      signedAt: at,
    });
    const checkId = newId("chk");
    await world.cli().api.call(routes.recordCheck, {
      params: { workspaceId: world.workspaceId },
      body: {
        id: checkId,
        noteId,
        noteVersion: 2,
        ciphertext: encryptCheck(
          world.key,
          { workspaceId: world.workspaceId, id: checkId },
          { actor: "claude-code/2.1", at, result: "pass", scope: [] },
        ).ciphertext,
      },
    });
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 2,
      name: "note.md",
      text: `---\ntype: Note\nverified:\n  - { by: ${owner}, at: ${at} }\n  - { by: claude-code/2.1, at: ${at} }\n---\nv2\n`,
      checkId,
    });
    // another client syncing from scratch, and again from its cache only
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const agent = world.cli({ cache });
    const seen = record(agent);
    await agent.engine.pull();
    const latest = notesIn(seen).at(-1);
    expect(latest).toMatchObject({ version: 3, signedWrite: null });
    expect(latest?.confirmations).toEqual([
      { version: 1, by: world.accountId, at: expect.any(String) as unknown },
      { version: 2, by: world.accountId, at },
    ]);
    const restored = world.cli({ cache });
    const fromCache = record(restored);
    await restored.engine.load();
    expect(notesIn(fromCache).at(-1)?.confirmations).toContainEqual({
      version: 2,
      by: world.accountId,
      at,
    });
  });
});

/** A folder the owner creates through the API, so the server and the feed know it. */
async function createFolder(
  world: World,
  web: Client,
  name: string,
  parentId: FolderId | null = null,
): Promise<FolderId> {
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

/** The requests that reached a route. */
function callsTo(world: World, path: RegExp, method = "PUT") {
  return world.server.requests.filter(
    (call) => call.init.method === method && path.test(call.url.replace(/\?.*$/, "")),
  );
}

const AGENT_WRITES = /\/agent-version$/;

/** The owner revokes the agent with a signed `token_revoked`, signed at `signedAt` (or now). */
async function revokeAgent(world: World, web: Client, signedAt?: string): Promise<void> {
  const revocation = signRevocation(world.signer, {
    workspaceId: world.workspaceId,
    tokenId: world.tokenId,
    recipientPublicKey: world.agent.publicKey,
    ...(signedAt === undefined ? {} : { signedAt }),
  });
  await web.api.call(routes.revokeToken, {
    params: { tokenId: world.tokenId },
    headers: signingHeaders(revocation),
  });
}

describe("agent direct writes (protocol 2)", () => {
  it("writes directly under the agent's own key, and every client verifies it", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const cli = world.cli();
    await cli.engine.pull();
    const noteId: NoteId = newId("note");

    const result = await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 0,
      name: "draft.md",
      text: note("by the agent"),
      record: { actor: "claude-code/2.1", summary: "Drafted the note" },
    });
    expect(result).toMatchObject({
      status: "saved",
      policyRevision: 0,
      recorded: true,
      note: {
        version: 1,
        signedWrite: null,
        agentWrite: { tokenId: world.tokenId, revision: 0, revoked: false },
      },
    });
    const sent = callsTo(world, AGENT_WRITES)[0];
    expect(sent?.init.headers).toMatchObject({ "knowtarium-agent-policy-revision": "0" });
    const stored = world.server.events.find((event) => event.noteVersion === 1);
    expect(stored).toMatchObject({ authorId: world.tokenId, authorTokenId: world.tokenId });

    // the web app takes it from the feed, verified under the key the owner vouched for
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const owner = world.web({ cache });
    const seen = record(owner);
    await owner.engine.pull();
    expect(notesIn(seen)).toMatchObject([
      {
        noteId,
        version: 1,
        text: note("by the agent"),
        signedWrite: null,
        confirmations: [],
        agentWrite: { tokenId: world.tokenId, revoked: false },
      },
    ]);
    expect(owner.engine.quarantined).toEqual([]);
    expect(await owner.engine.readNote(noteId)).toMatchObject({ agentWrite: { revision: 0 } });
    // and again from its cache, with the vouched key kept there (only the keyring is fetched)
    const later = world.web({ cache });
    const fromCache = record(later);
    const before = callsTo(world, /\/keys$/, "GET").length;
    await later.engine.load();
    expect(notesIn(fromCache)).toMatchObject([{ version: 1, agentWrite: { revoked: false } }]);
    expect(callsTo(world, /\/keys$/, "GET").length - before).toBe(1);
    // a cached key record nobody but the owner could sign doesn't pass either
    const forged = signAgentKey(
      { accountId: world.accountId, signing: createAccountKeys().signing },
      {
        workspaceId: world.workspaceId,
        tokenId: world.tokenId,
        signPublicKey: world.agentSigning.publicKey,
        policyRevision: 0,
      },
    );
    const cached = await cache.getNote(world.workspaceId, noteId);
    if (cached === undefined) throw new Error("expected the note in the cache");
    await cache.putNote({
      ...cached,
      agentKeys: [
        { signed: forged.signed as unknown as AgentKeyRecord["signed"], revokedAt: null },
      ],
    });
    const tampered = world.web({ cache });
    await tampered.engine.load();
    expect(tampered.engine.quarantined).toMatchObject([{ noteId, reason: "untrusted_signature" }]);
  });

  it("returns both versions on a 409 with the current version, then writes on top", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("the person's"),
    });
    const cli = world.cli();
    await cli.engine.pull();
    const stale = await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("the agent's"),
    });
    expect(stale).toMatchObject({
      status: "conflict",
      currentVersion: 1,
      mine: { baseVersion: 0, text: note("the agent's") },
      theirs: { version: 1, text: note("the person's") },
    });
    const retried = await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: note("the agent's, merged"),
    });
    expect(retried).toMatchObject({ status: "saved", note: { version: 2 } });
    const seen = record(web);
    await web.engine.pull();
    expect(notesIn(seen)).toMatchObject([{ version: 2, agentWrite: { tokenId: world.tokenId } }]);
  });

  it("refuses an agent version under a key the owner didn't vouch for", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const cli = world.cli();
    await cli.engine.pull();
    const noteId: NoteId = newId("note");
    const saved = await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: "agent",
    });
    expect(saved.status).toBe("saved");
    // the server swaps the vouched record for one signed by another key (not the owner's)
    const other = createAccountKeys();
    const forged = signAgentKey(
      { accountId: world.accountId, signing: other.signing },
      {
        workspaceId: world.workspaceId,
        tokenId: world.tokenId,
        signPublicKey: world.agentSigning.publicKey,
        policyRevision: 0,
      },
    );
    world.server.agentKeyRecords.splice(0, 1, {
      signed: forged.signed as unknown as AgentKeyRecord["signed"],
      revokedAt: null,
    });
    const owner = world.web();
    const seen = record(owner);
    await owner.engine.pull();
    expect(notesIn(seen)).toEqual([]);
    expect(owner.engine.quarantined).toMatchObject([
      { noteId, version: 1, reason: "untrusted_signature" },
    ]);
    // the agent itself sees its key isn't vouched for, and proposes instead
    const again = await world.cli().engine.writeAsAgent({
      noteId: newId("note"),
      folderId,
      baseVersion: 0,
      name: "other.md",
      text: "x",
    });
    expect(again).toEqual({ status: "agent_key_required" });
  });

  it("refuses an agent_edited signed by another agent's key, even with a vouched record", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const cli = world.cli();
    await cli.engine.pull();
    const noteId: NoteId = newId("note");
    await cli.engine.writeAsAgent({ noteId, folderId, baseVersion: 0, name: "a.md", text: "a" });
    // the server re-signs the event with a key of its own, keeping the owner's record
    const rogue = createAccountKeys().signing;
    world.server.tamper.events = (events) =>
      events.map((event) => {
        const signed = event.signed;
        if (signed?.envelope.type !== "agent_edited") return event;
        const resigned = signEnvelope(signed.envelope, rogue);
        return { ...event, signed: { ...signed, signature: resigned.signature } };
      });
    const owner = world.web();
    await owner.engine.pull();
    expect(owner.engine.quarantined).toMatchObject([{ noteId, reason: "untrusted_signature" }]);
  });

  it("flags a revoked agent's earlier versions, and refuses one signed after the revocation", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const cli = world.cli();
    await cli.engine.pull();
    const before: NoteId = newId("note");
    await cli.engine.writeAsAgent({
      noteId: before,
      folderId,
      baseVersion: 0,
      name: "before.md",
      text: "before",
    });
    await revokeAgent(world, web);
    const owner = world.web();
    const seen = record(owner);
    await owner.engine.pull();
    expect(notesIn(seen)).toMatchObject([
      { noteId: before, text: "before", agentWrite: { tokenId: world.tokenId, revoked: true } },
    ]);
    expect(owner.engine.quarantined).toEqual([]);

    // a version dated after the owner's signed revocation never counts
    const other = new World();
    const otherWeb = other.web();
    const otherFolder = await createFolder(other, otherWeb, "Agents");
    const otherCli = other.cli();
    await otherCli.engine.pull();
    const after: NoteId = newId("note");
    await otherCli.engine.writeAsAgent({
      noteId: after,
      folderId: otherFolder,
      baseVersion: 0,
      name: "after.md",
      text: "after",
    });
    // signed a minute before the agent's write: the write reads as after the revocation
    await revokeAgent(other, otherWeb, new Date(Date.now() - 60_000).toISOString());
    const otherOwner = other.web();
    await otherOwner.engine.pull();
    expect(otherOwner.engine.quarantined).toMatchObject([
      { noteId: after, reason: "untrusted_signature" },
    ]);
  });

  it("reads the policy again and retries once when the server says it is stale", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const set = await web.engine.setAgentPolicy({
      default: "direct",
      folders: [],
      baseRevision: 0,
    });
    expect(set).toMatchObject({ status: "saved", revision: 1 });
    const cli = world.cli();
    await cli.engine.pull();
    // the first read serves the old (empty) policy, as a server that lags would
    let reads = 0;
    world.server.tamper.agentPolicy = (policy) =>
      reads++ === 0 ? { ...missingAgentPolicy(), otherFolderHashes: [], ancestors: [] } : policy;
    const result = await cli.engine.writeAsAgent({
      noteId: newId("note"),
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: "x",
    });
    expect(result).toMatchObject({ status: "saved", policyRevision: 1 });
    const sent = callsTo(world, AGENT_WRITES).map(
      (call) => call.init.headers["knowtarium-agent-policy-revision"],
    );
    expect(sent).toEqual(["0", "1"]);
    expect(await cli.trust.agentPolicyRevision(world.workspaceId)).toBe(1);
  });

  it("falls back to proposing where the folder asks first, or the policy doesn't verify", async () => {
    const world = new World();
    const web = world.web();
    const review = await createFolder(world, web, "Ask first");
    const direct = await createFolder(world, web, "Direct");
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: review, mode: "review" }],
      baseRevision: 0,
    });
    const cli = world.cli();
    await cli.engine.pull();
    const write = (folderId: FolderId) =>
      cli.engine.writeAsAgent({
        noteId: newId("note"),
        folderId,
        baseVersion: 0,
        name: "note.md",
        text: "x",
      });
    expect(await write(review)).toEqual({
      status: "approval_required",
      reason: "policy",
      policyRevision: 1,
    });
    expect(callsTo(world, AGENT_WRITES)).toHaveLength(0);
    // the CLI then proposes, which every mode allows
    const proposed = await cli.engine.submitPending({
      noteId: newId("note"),
      folderId: review,
      baseVersion: 0,
      name: "note.md",
      text: "x",
    });
    expect(proposed.status).toBe("submitted");

    // the server flips the folder to direct without the owner's signature
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      folders: policy.folders.map((folder) => ({ ...folder, mode: "direct" as const })),
    });
    expect(await write(review)).toMatchObject({
      status: "approval_required",
      reason: "unverified_policy",
      problem: "hash_mismatch",
    });
    delete world.server.tamper.agentPolicy;

    // the server refuses on its own (its mode is the one that counts)
    world.server.tamper.refuse = (route) =>
      route === "writeNoteAsAgent" ? "approval_required" : undefined;
    expect(await write(direct)).toEqual({
      status: "approval_required",
      reason: "server",
      policyRevision: 1,
    });
    delete world.server.tamper.refuse;

    // an older policy than one seen is refused too (rollback)
    const old = world.server.agentPolicy;
    await web.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 1 });
    expect(await write(direct)).toMatchObject({ status: "saved", policyRevision: 2 });
    world.server.tamper.agentPolicy = () => ({ ...old, otherFolderHashes: [], ancestors: [] });
    expect(await write(direct)).toMatchObject({
      status: "approval_required",
      reason: "unverified_policy",
      problem: "below_floor",
    });
  });

  it("answers agent_key_required for a token the owner never vouched a key for", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    world.server.agentKeyRecords.length = 0;
    world.server.agentSignPublicKey = null;
    const cli = world.cli();
    await cli.engine.pull();
    expect(
      await cli.engine.writeAsAgent({
        noteId: newId("note"),
        folderId,
        baseVersion: 0,
        name: "note.md",
        text: "x",
      }),
    ).toEqual({ status: "agent_key_required" });
    expect(callsTo(world, AGENT_WRITES)).toHaveLength(0);
    // a person's engine has no agent key to write with: it can only propose
    expect(
      await web.engine.writeAsAgent({
        noteId: newId("note"),
        folderId,
        baseVersion: 0,
        name: "note.md",
        text: "x",
      }),
    ).toEqual({ status: "agent_key_required" });
  });

  it("respects a scoped token's inherited mode from folders above its scope", async () => {
    const world = new World();
    const web = world.web();
    const parent = await createFolder(world, web, "Clients");
    const scope = await createFolder(world, web, "Acme", parent);
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: parent, mode: "review" }],
      baseRevision: 0,
    });
    world.server.agentFolderIds = [scope];
    const cli = world.cli({ folderIds: [scope] });
    await cli.engine.pull();
    expect(
      await cli.engine.writeAsAgent({
        noteId: newId("note"),
        folderId: scope,
        baseVersion: 0,
        name: "note.md",
        text: "x",
      }),
    ).toMatchObject({ status: "approval_required", reason: "policy" });
    // the owner lets this one folder through: its own override wins over the inherited one
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [
        { folderId: parent, mode: "review" },
        { folderId: scope, mode: "direct" },
      ],
      baseRevision: 1,
    });
    expect(
      await cli.engine.writeAsAgent({
        noteId: newId("note"),
        folderId: scope,
        baseVersion: 0,
        name: "note.md",
        text: "x",
      }),
    ).toMatchObject({ status: "saved", policyRevision: 2 });
  });
});

describe("the owner's agent policy", () => {
  it("signs each revision, refuses a stale base with the current policy, and announces it", async () => {
    const world = new World();
    const web = world.web();
    expect((await web.engine.readAgentPolicy()).resolved).toMatchObject({ ok: true, revision: 0 });
    const first = await web.engine.setAgentPolicy({
      default: "review",
      folders: [],
      baseRevision: 0,
    });
    expect(first).toMatchObject({ status: "saved", revision: 1, policy: { default: "review" } });
    const stale = await web.engine.setAgentPolicy({
      default: "direct",
      folders: [],
      baseRevision: 0,
    });
    expect(stale).toMatchObject({
      status: "conflict",
      currentRevision: 1,
      current: { policy: { default: "review" }, resolved: { ok: true, revision: 1 } },
    });
    const seen = record(web);
    await web.engine.pull();
    expect(seen).toContainEqual(
      expect.objectContaining({ type: "workspace", agentPolicyRevision: 1 }),
    );
    // a session refuses a policy the server rewrote
    world.server.tamper.agentPolicy = (policy) => ({ ...policy, default: "direct" });
    expect((await web.engine.readAgentPolicy()).resolved).toMatchObject({
      ok: false,
      problem: "hash_mismatch",
    });
    // an agent's floor: what it saw at connect and since
    const cli = world.cli();
    delete world.server.tamper.agentPolicy;
    expect((await cli.engine.readAgentPolicy()).resolved).toMatchObject({ ok: true, revision: 1 });
  });

  it("reads only the full policy for a person, never an agent's view", async () => {
    const world = new World();
    const web = world.web();
    const review = await createFolder(world, web, "Ask first");
    const direct = await createFolder(world, web, "Direct");
    const folders = [
      { folderId: review, mode: "review" as const },
      { folderId: direct, mode: "direct" as const },
    ];
    await web.engine.setAgentPolicy({ default: "direct", folders, baseRevision: 0 });
    // this engine never pulled: it knows no folders, so visibleFolderIds alone can't catch it
    const full = await web.engine.readAgentPolicy();
    expect(full.resolved).toMatchObject({ ok: true, revision: 1, rules: { folders } });
    // empty view fields, as a whole-workspace view would carry, are still the full policy
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      otherFolderHashes: [],
      ancestors: [],
    });
    expect((await web.engine.readAgentPolicy()).resolved).toMatchObject({ ok: true, revision: 1 });

    // the review override moved among the hashes: the owner's signature still verifies
    const reviewHash = await agentPolicyFolderHash({ folderId: review, mode: "review" });
    const directHash = await agentPolicyFolderHash({ folderId: direct, mode: "direct" });
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      folders: policy.folders.filter((folder) => folder.folderId !== review),
      otherFolderHashes: [reviewHash],
      ancestors: [],
    });
    expect((await web.engine.readAgentPolicy()).resolved).toEqual({
      ok: false,
      problem: "hidden_override",
    });
    // passing the folders the caller knows doesn't make a view acceptable either
    const known = { visibleFolderIds: [review, direct] };
    expect((await web.engine.readAgentPolicy(known)).resolved).toMatchObject({ ok: false });
    // a stale save gets the current policy back, refused the same way, so nothing is saved over it
    const stale = await web.engine.setAgentPolicy({
      default: "review",
      folders: [],
      baseRevision: 0,
    });
    expect(stale).toMatchObject({
      status: "conflict",
      current: { resolved: { ok: false, problem: "hidden_override" } },
    });

    // every override hidden
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      folders: [],
      otherFolderHashes: [reviewHash, directHash],
      ancestors: [],
    });
    expect((await web.engine.readAgentPolicy()).resolved).toEqual({
      ok: false,
      problem: "hidden_override",
    });
    // ancestors never belong in a person's read
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      ancestors: [{ folderId: direct, ancestorIds: [] }],
    });
    expect((await web.engine.readAgentPolicy()).resolved).toEqual({
      ok: false,
      problem: "unexpected_ancestors",
    });

    // the agent still reads its view
    delete world.server.tamper.agentPolicy;
    world.server.agentFolderIds = [direct];
    const cli = world.cli({ folderIds: [direct] });
    await cli.engine.pull();
    expect((await cli.engine.readAgentPolicy()).resolved).toMatchObject({ ok: true, revision: 1 });
    expect(await web.engine.readAgentPolicy()).toMatchObject({ resolved: { ok: true } });
    // fetchAgentPolicy refuses that same view by default: only `view: true` accepts one
    const trust = {
      workspaceId: world.workspaceId,
      ownerSigningPublicKey: world.account.signing.publicKey,
      ownerAccountId: world.accountId,
      scopeFolderIds: [direct],
      visibleFolderIds: [direct],
    };
    expect((await fetchAgentPolicy(cli.api, trust)).resolved).toEqual({
      ok: false,
      problem: "hidden_override",
    });
    expect((await fetchAgentPolicy(cli.api, { ...trust, view: true })).resolved).toMatchObject({
      ok: true,
      revision: 1,
    });
  });

  it("never reads a person a policy below a revision signed into an agent key", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    const old = world.server.agentPolicy;
    await web.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 1 });
    // another device approved an agent at revision 2, since revoked
    const vouched = signAgentKey(world.signer, {
      workspaceId: world.workspaceId,
      tokenId: newId("tok"),
      signPublicKey: createAgentSigningKeyPair().publicKey,
      policyRevision: 2,
    }).signed as unknown as AgentKeyRecord["signed"];
    world.server.agentKeyRecords.push({ signed: vouched, revokedAt: new Date().toISOString() });
    // the server replays revision 1 to a device that never saw revision 2
    world.server.tamper.agentPolicy = () => old;
    const fresh = world.web();
    expect((await fresh.engine.readAgentPolicy()).resolved).toEqual({
      ok: false,
      problem: "below_floor",
    });
    // an old revision on purpose (an audit) has no floor
    expect((await fresh.engine.readAgentPolicy({ revision: 1 })).resolved).toMatchObject({
      ok: true,
      revision: 1,
    });
    delete world.server.tamper.agentPolicy;
    expect((await fresh.engine.readAgentPolicy()).resolved).toMatchObject({
      ok: true,
      revision: 2,
    });
  });

  it("audits an agent's version against the policy revision it named", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    await web.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 0 });
    const cli = world.cli();
    await cli.engine.pull();
    const noteId: NoteId = newId("note");
    await cli.engine.writeAsAgent({ noteId, folderId, baseVersion: 0, name: "a.md", text: "a" });
    await web.engine.pull();
    expect(await web.engine.auditAgentVersion(noteId, 1)).toEqual({
      status: "consistent",
      revision: 1,
      mode: "direct",
    });
    // the owner asks first in that folder now; the version was written under revision 1
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId, mode: "review" }],
      baseRevision: 1,
    });
    expect(await web.engine.auditAgentVersion(noteId, 1)).toMatchObject({ mode: "direct" });
    // a server that can't show the revision's owner signature
    world.server.tamper.agentPolicy = (policy) => ({ ...policy, default: "review" });
    expect(await web.engine.auditAgentVersion(noteId, 1)).toEqual({
      status: "unverifiable",
      revision: 1,
      problem: "hash_mismatch",
    });
    // nor an agent's view of it, for a person
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      ancestors: [{ folderId, ancestorIds: [] }],
    });
    expect(await web.engine.auditAgentVersion(noteId, 1)).toEqual({
      status: "unverifiable",
      revision: 1,
      problem: "unexpected_ancestors",
    });
    // a person's version isn't an agent's
    const own: NoteId = newId("note");
    await web.engine.writeNote({ noteId: own, folderId, baseVersion: 0, name: "b.md", text: "b" });
    await expect(web.engine.auditAgentVersion(own, 1)).rejects.toSatisfy((error: unknown) =>
      isVaultError(error, "untrusted_signature"),
    );
  });
});

describe("one agent policy per revision", () => {
  it("refuses a second owner-signed policy at a revision this device verified (a fork)", async () => {
    const world = new World();
    const web = world.web();
    const review = await createFolder(world, web, "Ask first");
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: review, mode: "review" }],
      baseRevision: 0,
    });
    const cli = world.cli();
    await cli.engine.pull();
    const write = (client: Client, noteId: NoteId = newId("note")) =>
      client.engine.writeAsAgent({
        noteId,
        folderId: review,
        baseVersion: 0,
        name: "note.md",
        text: "x",
      });
    expect(await write(cli)).toMatchObject({ status: "approval_required", reason: "policy" });

    // the server forgets the policy, so a fresh device sees revision 0 and the owner signs a
    // second revision 1 that drops "Ask me first"
    const real = world.server.agentPolicies.splice(0);
    const fresh = world.web();
    expect(
      await fresh.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 0 }),
    ).toMatchObject({ status: "saved", revision: 1 });

    // a person's read refuses it, so the UI never saves over it
    const read = await web.engine.readAgentPolicy();
    expect(read.resolved).toEqual({ ok: false, problem: "equivocation" });
    expect(() => requireVerifiedPolicy(read)).toThrow(
      expect.objectContaining({ code: "untrusted_signature" }),
    );
    // an agent that verified the real revision 1 proposes instead of writing
    expect(await write(cli)).toEqual({
      status: "approval_required",
      reason: "unverified_policy",
      policyRevision: null,
      problem: "equivocation",
    });
    expect(callsTo(world, AGENT_WRITES)).toHaveLength(0);

    // an agent with no history is fooled; the owner's audit flags the hash it signed
    const fooled = world.cli();
    await fooled.engine.pull();
    const noteId: NoteId = newId("note");
    expect(await write(fooled, noteId)).toMatchObject({ status: "saved", policyRevision: 1 });
    await web.engine.pull();
    expect(await web.engine.auditAgentVersion(noteId, 1)).toEqual({
      status: "policy_mismatch",
      revision: 1,
    });

    // the real revision again: the same hash is fine
    world.server.agentPolicies.splice(0, world.server.agentPolicies.length, ...real);
    expect((await web.engine.readAgentPolicy()).resolved).toMatchObject({ ok: true, revision: 1 });
    expect(await write(cli)).toMatchObject({ status: "approval_required", reason: "policy" });
    expect(await web.engine.auditAgentVersion(noteId, 1)).toEqual({
      status: "policy_mismatch",
      revision: 1,
    });
    // the device that signed the fork pinned it, so it refuses the real one
    expect((await fresh.engine.readAgentPolicy()).resolved).toEqual({
      ok: false,
      problem: "equivocation",
    });
    // an old revision read on purpose checks the pin too
    expect((await fresh.engine.readAgentPolicy({ revision: 1 })).resolved).toEqual({
      ok: false,
      problem: "equivocation",
    });
  });

  it("never signs over a revision older than one this device verified", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 1 });
    // the server goes back to revision 1 and would take a second revision 2 over it
    world.server.agentPolicies.splice(1);
    const sets = () => callsTo(world, /\/agent-policy$/);
    const before = sets().length;
    expect(
      await web.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 1 }),
    ).toMatchObject({
      status: "conflict",
      current: { resolved: { ok: false, problem: "below_floor" } },
    });
    expect(sets()).toHaveLength(before);
    expect(world.server.agentPolicies).toHaveLength(1);
  });

  it("never signs over a base below a revision it read on purpose", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    // another device saves revision 2; this one reads it on purpose (an audit)
    await world.web().engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 1 });
    expect((await web.engine.readAgentPolicy({ revision: 2 })).resolved).toMatchObject({
      ok: true,
      revision: 2,
    });
    expect(await web.trust.agentPolicyRevision(world.workspaceId)).toBe(2);
    // the server goes back to revision 1 and would take a second revision 2 over it
    world.server.agentPolicies.splice(1);
    const sets = () => callsTo(world, /\/agent-policy$/);
    const before = sets().length;
    expect(
      await web.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 1 }),
    ).toMatchObject({ status: "conflict" });
    expect(sets()).toHaveLength(before);
    expect(world.server.agentPolicies).toHaveLength(1);
    // a pin above the floor (recorded without raising it) counts too
    const trust = new TrustState(new MemoryTrustStorage());
    await trust.acceptAgentPolicy(world.workspaceId, 1, "hash", { raiseFloor: false });
    const other = world.web({ trust });
    expect(
      await other.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 0 }),
    ).toMatchObject({ status: "conflict" });
    expect(sets()).toHaveLength(before);
  });
});

describe("the fake server's agent routes, like the sync API", () => {
  it("refuses replays, a missing revision, read-only tokens and outside overrides", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const cli = world.cli();
    await cli.engine.pull();
    await cli.engine.writeAsAgent({
      noteId: newId("note"),
      folderId,
      baseVersion: 0,
      name: "a.md",
      text: "a",
    });
    const sent = callsTo(world, AGENT_WRITES)[0];
    if (sent === undefined) throw new Error("expected a write");
    const resend = (headers: Record<string, string>) =>
      world.server.fetch(sent.url, { ...sent.init, headers });
    const errorOf = async (answer: ReturnType<typeof world.server.fetch>) => {
      const bytes = new Uint8Array(await (await answer).arrayBuffer());
      return (JSON.parse(utf8Decode(bytes)) as { error: { code: string } }).error.code;
    };
    expect(await errorOf(resend(sent.init.headers))).toBe("invalid_signature");
    const without = Object.fromEntries(
      Object.entries(sent.init.headers).filter(
        ([key]) => key !== "knowtarium-agent-policy-revision",
      ),
    );
    expect(await errorOf(resend(without))).toBe("invalid_request");
    world.server.agentAccess = "read";
    const readOnly = await cli.engine
      .writeAsAgent({ noteId: newId("note"), folderId, baseVersion: 0, name: "b.md", text: "b" })
      .catch((error: unknown) => error);
    expect(isSyncApiError(readOnly, "scope_denied")).toBe(true);
    const outside = await web.engine
      .setAgentPolicy({
        default: "direct",
        folders: [{ folderId: newId("fld"), mode: "review" }],
        baseRevision: 0,
      })
      .catch((error: unknown) => error);
    expect(isSyncApiError(outside, "invalid_request")).toBe(true);
  });
});

/** An agent_edited row a server could add to the events list, signed with `signing`. */
function forgedAgentRow(
  world: World,
  noteId: NoteId,
  folderId: FolderId,
  version: number,
  signing: { publicKey: Uint8Array; privateKey: Uint8Array },
  seq: number,
): NoteEvent {
  const action = signAgentEdited(
    { tokenId: world.tokenId, ownerAccountId: world.accountId, signing },
    {
      workspaceId: world.workspaceId,
      noteId,
      folderId,
      baseVersion: version - 1,
      ciphertext: new Uint8Array(40).fill(version),
      revision: 0,
      policySha256: MISSING_AGENT_POLICY_SHA256,
    },
  );
  return {
    id: newId("evt"),
    workspaceId: world.workspaceId,
    noteId,
    noteVersion: version,
    authorId: world.tokenId,
    authorTokenId: world.tokenId,
    createdAt: new Date().toISOString(),
    seq,
    ciphertext: null,
    signed: action.signed as unknown as NoteEvent["signed"],
  };
}

describe("confirmations of an agent's version", () => {
  /** A person's confirmed v1, then the agent's v2 keeping the person's frontmatter. */
  async function setup() {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const noteId: NoteId = newId("note");
    const at = new Date().toISOString();
    const owner = `human:${world.accountId}`;
    const text = (body: string) =>
      `---\ntitle: Pricing\ngenerated: { by: "${owner}", at: "${at}" }\nverified:\n  - { by: "${owner}", at: "${at}" }\n---\n${body}\n`;
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: text("$20"),
      signedAt: at,
    });
    return { world, web, folderId, noteId, text };
  }

  it("shows none for an agent's version, whatever rows a server adds", async () => {
    const { world, folderId, noteId, text } = await setup();
    const cli = world.cli();
    await cli.engine.pull();
    await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: text("$2000"),
    });
    const seq = world.server.seq;
    const rogue = createAccountKeys().signing;
    // made-up higher versions (some the agent signed ahead, as a colluding agent could): no
    // feed row or event the client didn't accept changes what the accepted version shows
    world.server.tamper.events = (events) => [
      ...events,
      ...Array.from({ length: 10 }, (_, i) =>
        forgedAgentRow(
          world,
          noteId,
          folderId,
          100 + i,
          i % 2 === 0 ? rogue : world.agentSigning,
          seq,
        ),
      ),
    ];
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const viewer = world.web({ cache });
    const seen = record(viewer);
    await viewer.engine.pull();
    expect(notesIn(seen).at(-1)).toMatchObject({ version: 2, confirmations: [] });
    const later = world.web({ cache });
    const fromCache = record(later);
    await later.engine.load();
    expect(notesIn(fromCache).at(-1)).toMatchObject({ version: 2, confirmations: [] });
  });

  it("ignores a person's rejected write for the agent's version replayed as an event", async () => {
    const { world, web, folderId, noteId, text } = await setup();
    const cli = world.cli();
    await cli.engine.pull();
    await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: text("$2000"),
    });
    // the person's save on the old base: 409, but the server kept its signed `edited` for v2
    const at = new Date().toISOString();
    const lost = await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: text("$30"),
      signedAt: at,
    });
    expect(lost.status).toBe("conflict");
    const sent = callsTo(world, /\/notes\/[^/]+$/).at(-1);
    const replayed = signEdited(world.signer, {
      workspaceId: world.workspaceId,
      noteId,
      folderId,
      baseVersion: 1,
      ciphertext: (sent?.init.body as Uint8Array | undefined) ?? new Uint8Array(),
      signedAt: at,
    });
    expect(replayed.signature).toBe(sent?.init.headers["knowtarium-signature"]);
    const seq = world.server.seq;
    world.server.tamper.events = (events) => [
      ...events,
      {
        id: newId("evt"),
        workspaceId: world.workspaceId,
        noteId,
        noteVersion: 2,
        authorId: world.accountId,
        authorTokenId: null,
        createdAt: at,
        seq,
        ciphertext: null,
        signed: replayed.signed as unknown as NoteEvent["signed"],
      },
    ];
    const viewer = world.web();
    const seen = record(viewer);
    await viewer.engine.pull();
    expect(notesIn(seen).at(-1)).toMatchObject({
      version: 2,
      agentWrite: { tokenId: world.tokenId },
      confirmations: [],
    });
  });

  it("counts the person's confirmations again once they sign a version on top", async () => {
    const { world, web, folderId, noteId, text } = await setup();
    const cli = world.cli();
    await cli.engine.pull();
    await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: text("$2000"),
    });
    await web.engine.pull();
    const signed = await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 2,
      name: "note.md",
      text: text("$2000, checked"),
    });
    if (signed.status !== "saved") throw new Error("expected a save");
    expect(signed.note.confirmations.map((entry) => entry.version)).toEqual([1, 3]);
  });

  /** An agent records a passing check of `version`, and the person's session applies it. */
  async function applyCheck(
    world: World,
    web: Client,
    write: { noteId: NoteId; folderId: FolderId; version: number; text: string },
  ) {
    const checkId = newId("chk");
    await world.cli().api.call(routes.recordCheck, {
      params: { workspaceId: world.workspaceId },
      body: {
        id: checkId,
        noteId: write.noteId,
        noteVersion: write.version,
        ciphertext: encryptCheck(
          world.key,
          { workspaceId: world.workspaceId, id: checkId },
          { actor: "claude-code/2.1", at: new Date().toISOString(), result: "pass", scope: [] },
        ).ciphertext,
      },
    });
    const applied = await web.engine.writeNote({
      noteId: write.noteId,
      folderId: write.folderId,
      baseVersion: write.version,
      name: "note.md",
      text: write.text,
      checkId,
    });
    if (applied.status !== "saved") throw new Error("expected the check applied");
    return applied.note;
  }

  it("shows none for an applied check on top of an agent's version, from the feed and the cache", async () => {
    const { world, web, folderId, noteId, text } = await setup();
    const cli = world.cli();
    await cli.engine.pull();
    await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: text("$2000"),
    });
    await web.engine.pull();
    const first = await applyCheck(world, web, {
      noteId,
      folderId,
      version: 2,
      text: text("$2000."),
    });
    expect(first).toMatchObject({ version: 3, confirmations: [] });
    // consecutive applied checks look past each other to the agent's version
    const second = await applyCheck(world, web, {
      noteId,
      folderId,
      version: 3,
      text: text("$2000!"),
    });
    expect(second).toMatchObject({ version: 4, confirmations: [] });
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const viewer = world.web({ cache });
    const seen = record(viewer);
    await viewer.engine.pull();
    expect(notesIn(seen).at(-1)).toMatchObject({ version: 4, confirmations: [] });
    const later = world.web({ cache });
    const fromCache = record(later);
    await later.engine.load();
    expect(notesIn(fromCache).at(-1)).toMatchObject({ version: 4, confirmations: [] });
  });

  it("keeps the confirmations of an applied check on top of a person's version, past checks", async () => {
    const { world, web, folderId, noteId, text } = await setup();
    await applyCheck(world, web, { noteId, folderId, version: 1, text: text("$20.") });
    const second = await applyCheck(world, web, {
      noteId,
      folderId,
      version: 2,
      text: text("$20!"),
    });
    expect(second.confirmations.map((entry) => entry.version)).toEqual([1]);
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const viewer = world.web({ cache });
    const seen = record(viewer);
    await viewer.engine.pull();
    expect(
      notesIn(seen)
        .at(-1)
        ?.confirmations.map((entry) => entry.version),
    ).toEqual([1]);
    const later = world.web({ cache });
    const fromCache = record(later);
    await later.engine.load();
    expect(
      notesIn(fromCache)
        .at(-1)
        ?.confirmations.map((entry) => entry.version),
    ).toEqual([1]);
  });

  it("shows none for an applied check when the version below it is unknown or contested", async () => {
    const { world, web, folderId, noteId, text } = await setup();
    await applyCheck(world, web, { noteId, folderId, version: 1, text: text("$20.") });
    // the server leaves out the person's write below the check
    world.server.tamper.events = (events) =>
      events.filter((event) => !(event.noteId === noteId && event.noteVersion === 1));
    const viewer = world.web();
    const seen = record(viewer);
    await viewer.engine.pull();
    expect(notesIn(seen).at(-1)).toMatchObject({ version: 2, confirmations: [] });
    // or it adds an agent's row at that version beside the person's write
    const seq = world.server.seq;
    world.server.tamper.events = (events) => [
      ...events,
      forgedAgentRow(world, noteId, folderId, 1, createAccountKeys().signing, seq),
    ];
    const contested = world.web();
    const contestedSeen = record(contested);
    await contested.engine.pull();
    expect(notesIn(contestedSeen).at(-1)).toMatchObject({ version: 2, confirmations: [] });
  });

  it("is unaffected by agent rows forged at a version a person signed", async () => {
    const { world, web, folderId, noteId, text } = await setup();
    const at = new Date().toISOString();
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: text("$30"),
      signedAt: at,
    });
    const seq = world.server.seq;
    const rogue = createAccountKeys().signing;
    world.server.tamper.events = (events) => [
      ...events,
      forgedAgentRow(world, noteId, folderId, 2, rogue, seq),
      forgedAgentRow(world, noteId, folderId, 2, world.agentSigning, seq),
    ];
    const viewer = world.web();
    const seen = record(viewer);
    await viewer.engine.pull();
    expect(
      notesIn(seen)
        .at(-1)
        ?.confirmations.map((entry) => entry.version),
    ).toEqual([1, 2]);
  });
});

describe("agent direct writes: review fixes", () => {
  it("audits a version naming a revision below its agent's floor", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const cli = world.cli();
    await cli.engine.pull();
    const noteId: NoteId = newId("note");
    await cli.engine.writeAsAgent({ noteId, folderId, baseVersion: 0, name: "o.md", text: "o" });
    // the owner's record for this agent names a higher floor than the revision it wrote under
    const raised = signAgentKey(world.signer, {
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: world.agentSigning.publicKey,
      policyRevision: 5,
    });
    world.server.agentKeyRecords.splice(0, world.server.agentKeyRecords.length, {
      signed: raised.signed as unknown as AgentKeyRecord["signed"],
      revokedAt: null,
    });
    expect(await world.web().engine.auditAgentVersion(noteId, 1)).toEqual({
      status: "below_floor",
      revision: 0,
      floor: 5,
    });
  });

  it("gives an agent's version none of the person's earlier confirmations", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const noteId: NoteId = newId("note");
    const at = new Date().toISOString();
    const owner = `human:${world.accountId}`;
    const mine = (body: string) =>
      `---\ntitle: Pricing\ngenerated: { by: "${owner}", at: "${at}" }\nverified:\n  - { by: "${owner}", at: "${at}" }\n---\n${body}\n`;
    const saved = await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: mine("$20"),
      signedAt: at,
    });
    if (saved.status !== "saved") throw new Error("expected a save");
    expect(saved.note.confirmations).toHaveLength(1);
    // the agent changes the body and keeps the person's frontmatter as it was
    const cli = world.cli();
    await cli.engine.pull();
    const agents = await cli.engine.writeAsAgent({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: mine("$2000"),
    });
    expect(agents).toMatchObject({ status: "saved", note: { confirmations: [] } });
    const derive = (snapshot: NoteSnapshot) =>
      deriveVerification(parseNote(snapshot.text ?? "").frontmatter?.data ?? {}, {
        now: Date.now(),
        humanEntries: {
          confirmed: snapshot.confirmations.map((entry) => ({
            noteId,
            version: entry.version,
            by: `human:${entry.by}`,
            at: entry.at,
          })),
        },
        note: { noteId, version: snapshot.version },
      });
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const viewer = world.web({ cache });
    const seen = record(viewer);
    await viewer.engine.pull();
    const pulled = notesIn(seen).at(-1);
    if (pulled === undefined) throw new Error("expected the note");
    expect(pulled).toMatchObject({ version: 2, confirmations: [] });
    expect(derive(pulled).checkState).toBe("waiting-for-human");
    // from the cache too
    const later = world.web({ cache });
    const fromCache = record(later);
    await later.engine.load();
    const cached = notesIn(fromCache).at(-1);
    if (cached === undefined) throw new Error("expected the cached note");
    expect(cached.confirmations).toEqual([]);
    expect(derive(cached).checkState).toBe("waiting-for-human");
  });

  it("refuses a folder it doesn't know, and checks what a custom lookup reveals", async () => {
    const world = new World();
    const web = world.web();
    const scope = await createFolder(world, web, "Acme");
    const outside = await createFolder(world, web, "Private");
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: outside, mode: "review" }],
      baseRevision: 0,
    });
    world.server.agentFolderIds = [scope];
    const cli = world.cli({ folderIds: [scope] });
    await cli.engine.pull();
    const write = (folderId: FolderId, extra: object = {}) =>
      cli.engine.writeAsAgent({
        noteId: newId("note"),
        folderId,
        baseVersion: 0,
        name: "note.md",
        text: "x",
        ...extra,
      });
    // the World's default folder was never in the feed
    expect(await write(world.folderId)).toEqual({
      status: "approval_required",
      reason: "unknown_folder",
      policyRevision: null,
    });
    // a lookup that puts the scope under the private folder: its hidden override shows up
    const lookup = (folderId: string) =>
      folderId === scope
        ? { parentId: outside, deleted: false }
        : folderId === outside
          ? { parentId: null, deleted: false }
          : undefined;
    expect(await write(scope, { folders: lookup })).toMatchObject({
      status: "approval_required",
      reason: "unverified_policy",
      problem: "hidden_override",
    });
    expect(await write(scope)).toMatchObject({ status: "saved" });
  });

  it("checks the folder a move leaves, and maps the daily cap to rate_limited", async () => {
    const world = new World();
    const web = world.web();
    const asks = await createFolder(world, web, "Ask first");
    const open = await createFolder(world, web, "Open");
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({ noteId, folderId: asks, baseVersion: 0, name: "n.md", text: "x" });
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: asks, mode: "review" }],
      baseRevision: 0,
    });
    const cli = world.cli();
    await cli.engine.pull();
    expect(
      await cli.engine.writeAsAgent({
        noteId,
        folderId: open,
        baseVersion: 1,
        name: "n.md",
        text: "moved",
      }),
    ).toMatchObject({ status: "approval_required", reason: "policy" });
    expect(callsTo(world, AGENT_WRITES)).toHaveLength(0);
    world.server.agentWriteDailyCap = 0;
    expect(
      await cli.engine.writeAsAgent({
        noteId: newId("note"),
        folderId: open,
        baseVersion: 0,
        name: "new.md",
        text: "x",
      }),
    ).toEqual({ status: "rate_limited", retryAfterSeconds: 3600 });
  });

  it("shares a lookup's refetch, and never forgets a revocation", async () => {
    const world = new World();
    const web = world.web();
    const directory = new AgentKeyDirectory(web.api, world.workspaceId, {
      publicKey: world.account.signing.publicKey,
      accountId: world.accountId,
    });
    const records = [...world.server.agentKeyRecords];
    world.server.agentKeyRecords.length = 0;
    expect(await directory.forToken(newId("tok"))).toEqual([]);
    world.server.agentKeyRecords.push(...records);
    // two lookups of a token connected since: both wait for the one refetch
    const [first, second] = await Promise.all([
      directory.forToken(world.tokenId),
      directory.forToken(world.tokenId),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    await revokeAgent(world, web);
    directory.invalidate();
    expect(await directory.forToken(world.tokenId)).toMatchObject([
      { revoked: true, revokedSignedAt: expect.any(String) as unknown },
    ]);
    // the server stops listing the revocation: this engine still knows
    world.server.revocations.length = 0;
    world.server.tokenRevokedAt = null;
    directory.invalidate();
    expect(await directory.forToken(world.tokenId)).toMatchObject([
      { revoked: true, revokedSignedAt: expect.any(String) as unknown },
    ]);
  });

  it("reports cached agent versions again once their agent is revoked", async () => {
    const world = new World();
    const web = world.web();
    const folderId = await createFolder(world, web, "Agents");
    const cli = world.cli();
    await cli.engine.pull();
    const before: NoteId = newId("note");
    const after: NoteId = newId("note");
    await cli.engine.writeAsAgent({
      noteId: before,
      folderId,
      baseVersion: 0,
      name: "before.md",
      text: "before",
      signedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    await cli.engine.writeAsAgent({
      noteId: after,
      folderId,
      baseVersion: 0,
      name: "after.md",
      text: "after",
    });
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const owner = world.web({ cache });
    await owner.engine.pull();
    expect(owner.engine.quarantined).toEqual([]);
    // revoked between the two writes, then the key rotated without the agent
    await revokeAgent(world, web, new Date(Date.now() - 60_000).toISOString());
    const trust = new TrustState(new MemoryTrustStorage());
    await rotateWorkspace(web.api, {
      workspaceId: world.workspaceId,
      signer: world.signer,
      ownerBoxPublicKey: world.account.encryption.publicKey,
      keys: createKeyProvider(web.api, {
        workspaceId: world.workspaceId,
        recipient: world.account.encryption,
        ownerSigningPublicKey: world.account.signing.publicKey,
        ownerAccountId: world.accountId,
        trust,
      }),
      trust,
      exclude: [world.agent.publicKey],
    });
    const seen = record(owner);
    await owner.engine.pull();
    expect(notesIn(seen)).toMatchObject([{ noteId: before, agentWrite: { revoked: true } }]);
    expect(owner.engine.quarantined).toMatchObject([
      { noteId: after, reason: "untrusted_signature" },
    ]);
    // and the cache now keeps the revocation: a fresh load refuses it offline too
    const later = world.web({ cache });
    const fromCache = record(later);
    await later.engine.load();
    expect(notesIn(fromCache)).toMatchObject([{ noteId: before, agentWrite: { revoked: true } }]);
  });
});
