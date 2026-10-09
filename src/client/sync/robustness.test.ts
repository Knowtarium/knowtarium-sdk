import { beforeAll, describe, expect, it } from "vitest";

import { ready } from "../../crypto/index.js";
import type { NoteId } from "../../protocol/index.js";
import { EncryptedCache, MemoryCacheAdapter } from "../cache/index.js";
import {
  InvalidResponseError,
  isSyncApiError,
  isVaultError,
  SyncStoppedError,
} from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { fakeSockets } from "../testing/fake-socket.js";
import { flush } from "../testing/http.js";
import { type Client, World } from "../testing/world.js";
import type { SyncEvent } from "./events.js";

beforeAll(ready);

function record(client: Client): SyncEvent[] {
  const events: SyncEvent[] = [];
  client.engine.subscribe((event) => events.push(event));
  return events;
}

const errorsIn = (events: SyncEvent[]) =>
  events.flatMap((event) => (event.type === "error" ? [event.error] : []));
const notesIn = (events: SyncEvent[]) =>
  events.flatMap((event) => (event.type === "note" ? [event.note] : []));

async function writeNotes(world: World, count: number): Promise<NoteId[]> {
  const web = world.web();
  const ids: NoteId[] = [];
  for (let i = 0; i < count; i++) {
    const noteId: NoteId = newId("note");
    ids.push(noteId);
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: `n${String(i)}`,
    });
  }
  return ids;
}

describe("write results", () => {
  it("refuses a stored version other than base + 1, without moving any mark", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    world.server.tamper.stored = ({ note, event }) => ({
      note: { ...note, currentVersion: note.currentVersion + 5 },
      event,
    });
    const error = await web.engine
      .writeNote({ noteId, folderId: world.folderId, baseVersion: 0, name: "note.md", text: "x" })
      .catch((caught: unknown) => caught);
    expect(isVaultError(error, "version_mismatch")).toBe(true);
    expect(await web.trust.noteVersion(world.workspaceId, noteId)).toBe(0);
  });

  it("refuses a stored write in another folder", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    const elsewhere = newId("fld");
    world.server.tamper.stored = ({ note, event }) => ({
      note: { ...note, folderId: elsewhere },
      event,
    });
    const error = await web.engine
      .writeNote({ noteId, folderId: world.folderId, baseVersion: 0, name: "note.md", text: "x" })
      .catch((caught: unknown) => caught);
    expect(isVaultError(error, "version_mismatch")).toBe(true);
    expect(await web.trust.noteVersion(world.workspaceId, noteId)).toBe(0);
  });
});

describe("one queue per engine", () => {
  it("never applies a feed page read before its own later write", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "v1",
    });
    const seen = record(web);

    // the feed answer (note at version 1) is computed now but delivered only later
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.server.tamper.hold = (route) => (route === "listChanges" ? gate : undefined);
    const before = world.server.requests.length;
    const pull = web.engine.pull();
    const write = web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: "v2",
    });
    await flush();
    const sent = world.server.requests.slice(before);
    expect(sent.some(({ init }) => init.method === "PUT")).toBe(false);
    delete world.server.tamper.hold;
    release();
    await pull;
    expect(await write).toMatchObject({ status: "saved", note: { version: 2 } });
    expect(errorsIn(seen)).toEqual([]);
    expect(web.engine.quarantined).toEqual([]);
    expect(await web.trust.noteVersion(world.workspaceId, noteId)).toBe(2);
  });
});

describe("feed pages", () => {
  it("applies and saves the cursor page by page", async () => {
    const world = new World();
    await writeNotes(world, 3);
    const adapter = new MemoryCacheAdapter();
    const cache = new EncryptedCache(adapter);
    const cli = world.cli({ cache, pageSize: 1 });
    let pages = 0;
    world.server.tamper.changesPage = (page) =>
      ++pages === 3 ? { ...page, changes: [], hasMore: true } : page;
    const error = await cli.engine.pull().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidResponseError);
    // the workspace entry and the first note came in two pages, both saved
    expect(cli.engine.cursor).toBe(2);
    expect(await cache.cursor(world.workspaceId)).toBe(2);

    delete world.server.tamper.changesPage;
    const seen = record(cli);
    await cli.engine.pull();
    expect(notesIn(seen).map((note) => note.text)).toEqual(["n1", "n2"]);
    expect(cli.engine.cursor).toBe(world.server.seq);
  });

  it("refuses a page that claims more without moving forward", async () => {
    const world = new World();
    await writeNotes(world, 1);
    const cli = world.cli();
    world.server.tamper.changesPage = (page) => ({ ...page, changes: [], hasMore: true });
    await expect(cli.engine.pull()).rejects.toBeInstanceOf(InvalidResponseError);
    expect(cli.engine.cursor).toBe(0);
  });
});

describe("quarantine", () => {
  it("keeps a note that fails verification out, reports it, and retries it", async () => {
    const world = new World();
    const [noteId] = await writeNotes(world, 1);
    const adapter = new MemoryCacheAdapter();
    const cli = world.cli({ cache: new EncryptedCache(adapter) });
    world.server.tamper.versionBlob = (_note, _version, blob) => {
      const bad = blob.slice();
      bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
      return bad;
    };
    const seen = record(cli);
    await cli.engine.pull();
    expect(notesIn(seen)).toEqual([]);
    expect(cli.engine.quarantined).toEqual([{ noteId, version: 1, reason: "untrusted_signature" }]);
    expect(seen).toContainEqual({ type: "quarantine", notes: cli.engine.quarantined });

    // the set survives a restart
    const restarted = world.cli({ cache: new EncryptedCache(adapter) });
    await restarted.engine.load();
    expect(restarted.engine.quarantined).toHaveLength(1);

    // the next pull tries again, and a verified version releases the note
    delete world.server.tamper.versionBlob;
    const later = record(restarted);
    await restarted.engine.pull();
    expect(restarted.engine.quarantined).toEqual([]);
    expect(notesIn(later)).toMatchObject([{ noteId, version: 1, text: "n0" }]);
    expect(later).toContainEqual({ type: "quarantine", notes: [] });
  });
});

describe("cache authentication", () => {
  it("verifies cached versions again and quarantines a tampered one", async () => {
    const world = new World();
    const [noteId] = await writeNotes(world, 2);
    const adapter = new MemoryCacheAdapter();
    const first = world.cli({ cache: new EncryptedCache(adapter) });
    await first.engine.pull();

    // someone with access to the disk swaps a cached blob for another note's envelope
    const blobs = adapter.entries().filter(([key]) => key.endsWith("/blob"));
    const target = blobs.find(([key]) => key.includes(noteId ?? "none"));
    const other = blobs.find(([key]) => !key.includes(noteId ?? "none"));
    if (target === undefined || other === undefined) throw new Error("expected two cached blobs");
    await adapter.put(target[0], other[1]);

    const second = world.cli({ cache: new EncryptedCache(adapter) });
    const seen = record(second);
    await second.engine.load();
    expect(notesIn(seen).map((note) => note.text)).toEqual(["n1"]);
    expect(second.engine.quarantined).toMatchObject([{ noteId, reason: "untrusted_signature" }]);

    await second.engine.pull();
    expect(second.engine.quarantined).toEqual([]);
    expect(notesIn(seen).map((note) => note.text)).toEqual(["n1", "n0"]);
  });
});

describe("revocation", () => {
  it("stops for good on a revoked ping", async () => {
    const world = new World();
    const cli = world.cli();
    const { connect, sockets } = fakeSockets();
    const seen = record(cli);
    cli.engine.connectLive(connect);
    await flush();
    sockets[0]?.receive({ type: "revoked" });
    expect(cli.engine.revoked).toBe(true);
    expect(seen).toContainEqual({ type: "revoked" });
    await expect(cli.engine.pull()).rejects.toBeInstanceOf(SyncStoppedError);
    expect(() => cli.engine.connectLive(connect)).toThrow(SyncStoppedError);
  });

  it("stops for good when the token is revoked", async () => {
    const world = new World();
    const cli = world.cli();
    world.server.tamper.refuse = (route) => (route === "listChanges" ? "token_revoked" : undefined);
    const error = await cli.engine.pull().catch((caught: unknown) => caught);
    expect(isSyncApiError(error, "token_revoked")).toBe(true);
    expect(cli.engine.revoked).toBe(true);
    delete world.server.tamper.refuse;
    const requests = world.server.requests.length;
    await expect(cli.engine.pull()).rejects.toBeInstanceOf(SyncStoppedError);
    expect(world.server.requests.length).toBe(requests);
  });
});
