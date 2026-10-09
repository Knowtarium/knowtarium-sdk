import * as fakeIndexedDb from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";

import { ready } from "../../crypto/index.js";
import { isVaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { type IdbFactoryLike, IndexedDbTrustStorage } from "./indexeddb-trust.js";
import { TrustState } from "./trust.js";

beforeAll(ready);

// fake-indexeddb's types name DOM types, which src/ doesn't load
const IDBFactory = (fakeIndexedDb as unknown as { IDBFactory: new () => IdbFactoryLike })
  .IDBFactory;

describe("IndexedDB trust storage", () => {
  it("keeps marks across connections", async () => {
    const factory = new IDBFactory();
    const workspaceId = newId("ws");
    const noteId = newId("note");
    const first = await IndexedDbTrustStorage.open(factory, "trust-test");
    await new TrustState(first).acceptNoteVersion(workspaceId, noteId, 7);
    expect(await first.get("missing")).toBeUndefined();
    first.close();

    const second = await IndexedDbTrustStorage.open(factory, "trust-test");
    const state = new TrustState(second);
    expect(await state.noteVersion(workspaceId, noteId)).toBe(7);
    const refused = await state.acceptNoteVersion(workspaceId, noteId, 6).catch((e: unknown) => e);
    expect(isVaultError(refused, "rollback")).toBe(true);
    second.close();
  });

  it("forgets an owner pin", async () => {
    const factory = new IDBFactory();
    const workspaceId = newId("ws");
    const state = new TrustState(await IndexedDbTrustStorage.open(factory, "unpin-test"));
    await state.pinOwnerKey(workspaceId, "AAAA");
    expect(await state.ownerKey(workspaceId)).toBeDefined();
    await state.unpinOwnerKey(workspaceId);
    expect(await state.ownerKey(workspaceId)).toBeUndefined();
    await state.pinOwnerKey(workspaceId, "BBBB");
  });

  it("never stores the email a KDF mark belongs to", async () => {
    const factory = new IDBFactory();
    const storage = await IndexedDbTrustStorage.open(factory, "kdf-test");
    const state = new TrustState(storage);
    const kdf = {
      algorithm: "argon2id13",
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
      opsLimit: 4,
      memLimitBytes: 128 << 20,
    } as const;
    await state.recordKdfParams(" Person@Example.com ", kdf);
    const weaker = { ...kdf, opsLimit: 3 };
    const refused = await state
      .checkKdfParams("person@example.com", weaker)
      .catch((e: unknown) => e);
    expect(isVaultError(refused, "rollback")).toBe(true);
    expect(await storage.get("kdf/person@example.com")).toBeUndefined();
    storage.close();
  });
});
