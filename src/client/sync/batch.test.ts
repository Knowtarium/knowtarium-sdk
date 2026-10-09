import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ready } from "../../crypto/index.js";
import { type NoteId, VERSIONS_BATCH_MAX_BYTES } from "../../protocol/index.js";
import { EncryptedCache, MemoryCacheAdapter } from "../cache/index.js";
import { SyncApiError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { type Client, World } from "../testing/world.js";
import { prefetchVersions, VERSIONS_BATCH_RETRY_MS } from "./batch.js";

beforeAll(ready);

const singleReads = (world: World) =>
  world.server.requests.filter(({ url }) => /\/notes\/[^/]+\/versions\/\d+/.test(url)).length;

async function seed(world: World, count: number): Promise<NoteId[]> {
  const web = world.web();
  const ids: NoteId[] = [];
  for (let i = 0; i < count; i++) {
    const noteId: NoteId = newId("note");
    ids.push(noteId);
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: `n${String(i)}.md`,
      text: `note ${String(i)}`,
    });
  }
  return ids;
}

async function pullAll(client: Client): Promise<Map<string, string | null>> {
  const seen = new Map<string, string | null>();
  client.engine.on("note", (event) => seen.set(event.note.noteId, event.note.text));
  await client.engine.pull();
  return seen;
}

describe("batched version reads", () => {
  it("pulls hundreds of notes in a few requests, each verified as before", async () => {
    const world = new World();
    const ids = await seed(world, 250);
    world.server.requests.length = 0;
    const seen = await pullAll(world.cli());
    expect(seen.size).toBe(250);
    expect(seen.get(ids[123] ?? "")).toBe("note 123");
    expect(world.server.versionBatches).toBe(3);
    expect(singleReads(world)).toBe(0);
  });

  it("refills an emptied cache in batches when the trust marks survived", async () => {
    const world = new World();
    const ids = await seed(world, 250);
    const first = world.cli({ cache: new EncryptedCache(new MemoryCacheAdapter()) });
    expect((await pullAll(first)).size).toBe(250);
    // the cache is gone (sign-out, a memory fallback, clearWorkspace), the trust marks are not
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const again = world.cli({ trust: first.trust, cache });
    world.server.requests.length = 0;
    world.server.versionBatches = 0;
    const seen = await pullAll(again);
    expect(seen.size).toBe(250);
    expect(seen.get(ids[200] ?? "")).toBe("note 200");
    expect(world.server.versionBatches).toBe(3);
    expect(singleReads(world)).toBe(0);
    expect((await cache.listNotes(world.workspaceId)).length).toBe(250);
    // and a warm cache at the same marks reads nothing at all
    world.server.requests.length = 0;
    world.server.versionBatches = 0;
    await world.cli({ trust: first.trust, cache }).engine.pull();
    expect(world.server.versionBatches).toBe(0);
    expect(singleReads(world)).toBe(0);
  });

  it("reads what a batch leaves out one by one", async () => {
    const world = new World();
    await seed(world, 30);
    world.server.versionBatchBytes = 2000;
    world.server.requests.length = 0;
    const seen = await pullAll(world.cli());
    expect(seen.size).toBe(30);
    expect(singleReads(world)).toBeGreaterThan(0);
    expect(singleReads(world)).toBeLessThan(30);
  });

  it("verifies batched blobs like single ones: a swapped blob is quarantined", async () => {
    const world = new World();
    const [first, second] = await seed(world, 2);
    if (first === undefined || second === undefined) throw new Error("expected two notes");
    const other = world.server.notes.get(second)?.versions[0]?.blob;
    world.server.tamper.versionBlob = (noteId, _version, blob) =>
      noteId === first && other != null ? other : blob;
    const cli = world.cli();
    const seen = await pullAll(cli);
    expect(seen.has(first)).toBe(false);
    expect(seen.has(second)).toBe(true);
    expect(cli.engine.quarantined.map((entry) => entry.noteId)).toEqual([first]);
  });

  it("falls back to single reads for a server without the route", async () => {
    const world = new World();
    await seed(world, 5);
    world.server.tamper.refuse = (route) => (route === "getVersions" ? "not_found" : undefined);
    world.server.requests.length = 0;
    const cli = world.cli();
    const seen = await pullAll(cli);
    expect(seen.size).toBe(5);
    expect(singleReads(world)).toBe(5);
    await seed(world, 2);
    const batchCalls = () =>
      world.server.requests.filter(({ url }) => url.includes("/version-batches")).length;
    const before = batchCalls();
    await cli.engine.pull();
    expect(batchCalls()).toBe(before);
  });
});

/** A stand-in client whose `getVersions` answers with `answer` (or throws it). */
function stubApi(answer: () => unknown) {
  const api = {
    calls: 0,
    call: () => {
      api.calls++;
      const result = answer();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve({ data: result });
    },
  };
  return api;
}

const wantedNotes = (count: number) =>
  Array.from({ length: count }, () => ({ noteId: newId("note"), version: 1 }));

describe("batched version reads against a misbehaving server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops decoding at the byte cap and ignores what wasn't asked for", async () => {
    const workspaceId = newId("ws");
    const wanted = wantedNotes(3);
    // three answers of about 7 MiB each: only two fit under the 16 MiB cap
    const big = "A".repeat(Math.ceil((7 * 1024 * 1024 * 4) / 3));
    const api = stubApi(() => ({
      versions: [
        { noteId: newId("note"), version: 1, ciphertext: "AAAA" },
        ...wanted.map(({ noteId, version }) => ({ noteId, version, ciphertext: big })),
      ],
      omitted: [],
    }));
    const found = await prefetchVersions({ api: api as never, workspaceId }, wanted);
    expect(found.size).toBe(2);
    const total = [...found.values()].reduce((sum, blob) => sum + blob.length, 0);
    expect(total).toBeLessThanOrEqual(VERSIONS_BATCH_MAX_BYTES);
  });

  it("turns batching off only for the client that got a 404, and tries again later", async () => {
    const notFound = () =>
      new SyncApiError(404, { code: "not_found", message: "no route" }, "POST /version-batches");
    const workspaceId = newId("ws");
    const first = stubApi(notFound);
    const other = stubApi(() => ({ versions: [], omitted: [] }));
    const wanted = wantedNotes(2);
    await prefetchVersions({ api: first as never, workspaceId }, wanted);
    await prefetchVersions({ api: first as never, workspaceId }, wanted);
    expect(first.calls).toBe(1);
    await prefetchVersions({ api: other as never, workspaceId }, wanted);
    expect(other.calls).toBe(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + VERSIONS_BATCH_RETRY_MS + 1);
    await prefetchVersions({ api: first as never, workspaceId }, wanted);
    expect(first.calls).toBe(2);
  });
});
