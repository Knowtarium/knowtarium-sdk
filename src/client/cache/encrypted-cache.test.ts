import { beforeAll, describe, expect, it } from "vitest";

import { createWorkspaceKey, encryptText, isCryptoError, ready } from "../../crypto/index.js";
import { utf8Encode } from "../../crypto/encoding.js";
import type { NoteId, WorkspaceId } from "../../protocol/index.js";
import { newId } from "../platform/ids.js";
import { decryptLocalBlob, encryptFolderName } from "../vault/index.js";
import { MemoryCacheAdapter } from "./adapter.js";
import { EncryptedCache } from "./encrypted-cache.js";

beforeAll(ready);

const MARKER = "cached-plaintext-marker";

function setup() {
  const adapter = new MemoryCacheAdapter();
  const cache = new EncryptedCache(adapter);
  const key = createWorkspaceKey();
  const workspaceId: WorkspaceId = newId("ws");
  return { adapter, cache, key, workspaceId };
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

describe("encrypted cache", () => {
  it("keeps notes, folders, the workspace and the cursor", async () => {
    const { cache, key, workspaceId } = setup();
    const noteId: NoteId = newId("note");
    const folderId = newId("fld");
    const ciphertext = encryptText(key, MARKER, { kind: "note", workspaceId, id: noteId });
    await cache.putNote({ workspaceId, noteId, folderId, version: 2, deleted: false, ciphertext });
    await cache.putFolder({
      workspaceId,
      folderId,
      parentId: null,
      encName: encryptFolderName(key, { workspaceId, folderId }, MARKER),
      deleted: false,
    });
    await cache.setCursor(workspaceId, 9);
    expect(await cache.getNote(workspaceId, noteId)).toEqual({
      workspaceId,
      noteId,
      folderId,
      version: 2,
      deleted: false,
      ciphertext,
    });
    expect(await cache.listNotes(workspaceId)).toHaveLength(1);
    expect(await cache.listFolders(workspaceId)).toMatchObject([{ folderId, parentId: null }]);
    expect(await cache.cursor(workspaceId)).toBe(9);

    await cache.putNote({ workspaceId, noteId, folderId, version: 3, deleted: true });
    expect(await cache.getNote(workspaceId, noteId)).toEqual({
      workspaceId,
      noteId,
      folderId,
      version: 3,
      deleted: true,
    });
    await cache.clearWorkspace(workspaceId);
    expect(await cache.listNotes(workspaceId)).toEqual([]);
    expect(await cache.cursor(workspaceId)).toBe(0);
  });

  it("refuses plaintext where ciphertext belongs", async () => {
    const { cache, workspaceId } = setup();
    const plain = utf8Encode(`${MARKER} and more text so it is long enough to look like a blob`);
    const note = {
      workspaceId,
      noteId: newId("note"),
      folderId: newId("fld"),
      version: 1,
      deleted: false,
      ciphertext: plain,
    };
    await expect(cache.putNote(note)).rejects.toSatisfy((error) => isCryptoError(error));
    await expect(
      cache.putFolder({
        workspaceId,
        folderId: newId("fld"),
        parentId: null,
        encName: "UmVzZWFyY2ggbm90ZXMgZm9yIHRoZSBjbGllbnQgbWVldGluZyBpbiBPY3RvYmVy",
        deleted: false,
      }),
    ).rejects.toSatisfy((error) => isCryptoError(error));
  });

  it("builds keys only from valid IDs", async () => {
    const { cache } = setup();
    await expect(cache.cursor("ws_../../etc")).rejects.toThrow();
    await expect(cache.getNote(newId("ws"), "note_../x")).rejects.toThrow();
  });

  it("stores the search index encrypted", async () => {
    const { adapter, cache, key, workspaceId } = setup();
    const serialized = JSON.stringify({ terms: [MARKER] });
    await cache.putSearchIndex(workspaceId, key, serialized);
    for (const [, value] of adapter.entries()) expect(latin1(value)).not.toContain(MARKER);
    expect(await cache.getSearchIndex(workspaceId, key)).toBe(serialized);
    expect(await cache.getSearchIndex(newId("ws"), key)).toBeUndefined();
  });
});

describe("local-cache blobs", () => {
  it("keeps a graph layout apart from the search index, encrypted and bound to its kind", async () => {
    const { adapter, cache, key, workspaceId } = setup();
    const layout = JSON.stringify({ [MARKER]: [1, 2] });
    await cache.putLocalBlob(workspaceId, { kind: "graph_layout" }, key, layout);
    await cache.putSearchIndex(workspaceId, key, "index");
    expect(await cache.getLocalText(workspaceId, { kind: "graph_layout" }, key)).toBe(layout);
    expect(await cache.getSearchIndex(workspaceId, key)).toBe("index");
    expect(await cache.getLocalBlob(workspaceId, { kind: "graph_layout", id: "other" }, key)).toBe(
      undefined,
    );
    for (const [, value] of adapter.entries()) expect(latin1(value)).not.toContain(MARKER);
    // a layout blob can't be read as another kind or id
    const [stored] = adapter.entries().filter(([path]) => path.includes("/local/graph_layout/"));
    let refused: unknown = null;
    try {
      decryptLocalBlob(key, { workspaceId, kind: "search_index" }, stored?.[1] ?? new Uint8Array());
    } catch (error) {
      refused = error;
    }
    expect(isCryptoError(refused, "decryption_failed")).toBe(true);
    await cache.deleteLocalBlob(workspaceId, { kind: "graph_layout" });
    expect(await cache.getLocalBlob(workspaceId, { kind: "graph_layout" }, key)).toBeUndefined();
    await expect(
      cache.putLocalBlob(workspaceId, { kind: "graph_layout", id: "../x" }, key, "x"),
    ).rejects.toThrow(/invalid local blob id/);
    await expect(
      cache.putLocalBlob(workspaceId, { kind: "note" as never }, key, "x"),
    ).rejects.toThrow(/local-cache blob kind/);
  });
});
