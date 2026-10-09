import * as fakeIndexedDb from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";

import { createWorkspaceKey, encryptText, ready } from "../../crypto/index.js";
import type { NoteId, WorkspaceId } from "../../protocol/index.js";
import { newId } from "../platform/ids.js";
import type { IdbFactoryLike } from "../platform/indexeddb.js";
import { encryptFolderName } from "../vault/index.js";
import { EncryptedCache } from "./encrypted-cache.js";
import { type CacheFallback, IndexedDbCacheAdapter } from "./indexeddb-cache.js";

beforeAll(ready);

// fake-indexeddb's types name DOM types, which src/ doesn't load
const IDBFactory = (fakeIndexedDb as unknown as { IDBFactory: new () => IdbFactoryLike })
  .IDBFactory;

const MARKER = "cached-plaintext-marker";

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/** Fills one workspace's cache with a note, a folder and a cursor. */
async function fill(cache: EncryptedCache, workspaceId: WorkspaceId) {
  const key = createWorkspaceKey();
  const noteId: NoteId = newId("note");
  const folderId = newId("fld");
  await cache.putNote({
    workspaceId,
    noteId,
    folderId,
    version: 1,
    deleted: false,
    ciphertext: encryptText(key, MARKER, { kind: "note", workspaceId, id: noteId }),
  });
  await cache.putFolder({
    workspaceId,
    folderId,
    parentId: null,
    encName: encryptFolderName(key, { workspaceId, folderId }, MARKER),
    deleted: false,
  });
  await cache.setCursor(workspaceId, 7);
  return { noteId };
}

describe("IndexedDB cache adapter", () => {
  it("keeps the encrypted cache across reloads, with nothing readable in it", async () => {
    const factory = new IDBFactory();
    const accountId = newId("acc");
    const workspaceId: WorkspaceId = newId("ws");
    const first = await IndexedDbCacheAdapter.open(factory, { accountId });
    const { noteId } = await fill(new EncryptedCache(first), workspaceId);
    first.close();

    const second = await IndexedDbCacheAdapter.open(factory, { accountId });
    const cache = new EncryptedCache(second);
    expect(await cache.cursor(workspaceId)).toBe(7);
    expect((await cache.getNote(workspaceId, noteId))?.version).toBe(1);
    expect(await cache.listFolders(workspaceId)).toHaveLength(1);
    const keys = await second.list("");
    expect(keys.length).toBeGreaterThan(2);
    for (const key of keys) {
      expect(latin1((await second.get(key)) ?? new Uint8Array())).not.toContain(MARKER);
    }
    expect(second.fallback).toBeNull();
    second.close();
  });

  it("keeps accounts in separate databases and clears one workspace or everything", async () => {
    const factory = new IDBFactory();
    const alice = await IndexedDbCacheAdapter.open(factory, { accountId: newId("acc") });
    const bob = await IndexedDbCacheAdapter.open(factory, { accountId: newId("acc") });
    const one: WorkspaceId = newId("ws");
    const two: WorkspaceId = newId("ws");
    await fill(new EncryptedCache(alice), one);
    await fill(new EncryptedCache(alice), two);
    expect(await bob.list("")).toEqual([]);

    await alice.clearWorkspace(one);
    expect(await alice.list(`ws/${one}/`)).toEqual([]);
    expect((await alice.list(`ws/${two}/`)).length).toBeGreaterThan(0);
    await alice.clearAll();
    expect(await alice.list("")).toEqual([]);
  });

  it("refuses keys that aren't made of IDs, and account IDs that aren't", async () => {
    const adapter = await IndexedDbCacheAdapter.open(new IDBFactory(), {
      accountId: newId("acc"),
    });
    await expect(adapter.put("ws/../x", new Uint8Array())).rejects.toThrow(/invalid cache key/);
    await expect(adapter.get("a b")).rejects.toThrow(/invalid cache key/);
    await expect(
      IndexedDbCacheAdapter.open(new IDBFactory(), { accountId: "someone" }),
    ).rejects.toThrow();
  });

  it("carries on in memory when the storage is full, and says so once", async () => {
    const reports: CacheFallback[] = [];
    const adapter = await IndexedDbCacheAdapter.open(quotaFactory(new IDBFactory()), {
      accountId: newId("acc"),
      onFallback: (fallback) => reports.push(fallback),
    });
    const workspaceId: WorkspaceId = newId("ws");
    const cache = new EncryptedCache(adapter);
    await fill(cache, workspaceId);
    expect(await cache.cursor(workspaceId)).toBe(7);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.reason).toBe("quota");
    expect(adapter.fallback?.reason).toBe("quota");
  });

  it("carries on in memory when IndexedDB can't be opened", async () => {
    const reports: CacheFallback[] = [];
    const broken: IdbFactoryLike = {
      open: () => {
        const request = {
          result: null,
          error: new Error("blocked"),
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        void Promise.resolve().then(() => {
          (request.onerror as (() => void) | null)?.();
        });
        return request;
      },
    };
    const adapter = await IndexedDbCacheAdapter.open(broken, {
      accountId: newId("acc"),
      onFallback: (fallback) => reports.push(fallback),
    });
    const workspaceId: WorkspaceId = newId("ws");
    const cache = new EncryptedCache(adapter);
    await cache.setCursor(workspaceId, 3);
    expect(await cache.cursor(workspaceId)).toBe(3);
    expect(reports.map((report) => report.reason)).toEqual(["unavailable"]);
  });
});

/** A factory whose writes fail like a full disk: the transaction aborts with QuotaExceededError. */
function quotaFactory(inner: IdbFactoryLike): IdbFactoryLike {
  return {
    open: (name, version) => {
      const request = inner.open(name, version);
      const original = request as { result: unknown };
      return new Proxy(request, {
        get(target, property, receiver) {
          if (property !== "result") return Reflect.get(target, property, receiver) as unknown;
          const db = original.result as {
            transaction(store: string, mode: string): Record<string, unknown>;
          } | null;
          if (db === null) return db;
          return new Proxy(db, {
            get(dbTarget, dbProperty) {
              if (dbProperty !== "transaction") {
                const value = Reflect.get(dbTarget, dbProperty) as unknown;
                return typeof value === "function"
                  ? (value as () => unknown).bind(dbTarget)
                  : value;
              }
              return (store: string, mode: string) => {
                if (mode !== "readwrite") return dbTarget.transaction(store, mode);
                const fake = {
                  error: Object.assign(new Error("full"), { name: "QuotaExceededError" }),
                  oncomplete: null as unknown,
                  onerror: null as unknown,
                  onabort: null as unknown,
                  objectStore: () => ({
                    // deletes free space, so they go through
                    delete: () => {
                      void Promise.resolve().then(() => {
                        (fake.oncomplete as (() => void) | null)?.();
                      });
                      return {};
                    },
                    put: () => {
                      void Promise.resolve().then(() => {
                        (fake.onabort as (() => void) | null)?.();
                      });
                      return {};
                    },
                  }),
                };
                return fake;
              };
            },
          });
        },
        set(target, property, value) {
          return Reflect.set(target, property, value);
        },
      });
    },
  };
}
