import { beforeAll, describe, expect, it } from "vitest";

import { createWorkspaceKey, encryptText, isCryptoError, ready } from "../../crypto/index.js";
import { newId } from "../platform/ids.js";
import {
  decryptComment,
  decryptFolderName,
  decryptNote,
  decryptPendingNote,
  decryptTitle,
  decryptWorkspaceName,
  encryptComment,
  encryptFolderName,
  encryptNote,
  encryptPendingNote,
  encryptTitle,
} from "./content.js";
import type { FolderId } from "../../protocol/index.js";
import { NoteTooLargeError, RequestValidationError } from "../errors/index.js";
import { World } from "../testing/world.js";
import { noteContext, pendingContext } from "./contexts.js";
import { prepareFolder, prepareFolderUpdate } from "./workspace.js";
import { decryptSearchIndex, encryptSearchIndex } from "./search-index.js";

beforeAll(ready);

function failsToDecrypt(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return isCryptoError(error, "decryption_failed");
  }
}

describe("content helpers", () => {
  it("round trips each kind under its own context", () => {
    const key = createWorkspaceKey();
    const workspaceId = newId("ws");
    const noteId = newId("note");
    const folderId = newId("fld");
    const ref = { workspaceId, noteId };
    const file = { name: "pricing.md", text: "body" };
    expect(decryptNote(key, ref, encryptNote(key, ref, file))).toEqual(file);
    const pending = { ...ref, folderId, baseVersion: 3, nonce: "n0nce" };
    const draft = { name: "draft.md", text: "draft" };
    expect(decryptPendingNote(key, pending, encryptPendingNote(key, pending, draft))).toEqual(
      draft,
    );
    expect(decryptTitle(key, ref, encryptTitle(key, ref, "Title"))).toBe("Title");
    const folder = { workspaceId, folderId };
    expect(decryptFolderName(key, folder, encryptFolderName(key, folder, "Research"))).toBe(
      "Research",
    );
    const commentId = newId("cmt");
    const sealed = encryptComment(key, { workspaceId, id: commentId }, { text: "hi" });
    expect(decryptComment(key, { workspaceId, id: commentId }, sealed.ciphertext)).toEqual({
      text: "hi",
    });
  });

  it("keeps kinds apart: a proposal is not a note, a folder name not a workspace name", () => {
    const key = createWorkspaceKey();
    const workspaceId = newId("ws");
    const ref = { workspaceId, noteId: newId("note") };
    const pending = { ...ref, folderId: newId("fld"), baseVersion: 1, nonce: "a" };
    expect(
      failsToDecrypt(() =>
        decryptNote(key, ref, encryptPendingNote(key, pending, { name: "x.md", text: "x" })),
      ),
    ).toBe(true);
    const folderName = encryptFolderName(key, { workspaceId, folderId: newId("fld") }, "x");
    expect(failsToDecrypt(() => decryptWorkspaceName(key, workspaceId, folderName))).toBe(true);
  });
});

describe("pending binding", () => {
  it("binds a proposal to its note, folder, base version and nonce", () => {
    const key = createWorkspaceKey();
    const pending = {
      workspaceId: newId("ws"),
      noteId: newId("note"),
      folderId: newId("fld"),
      baseVersion: 2,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    const blob = encryptPendingNote(key, pending, { name: "proposal.md", text: "proposal" });
    const others = [
      { ...pending, noteId: newId("note") },
      { ...pending, folderId: newId("fld") },
      { ...pending, baseVersion: 3 },
      { ...pending, nonce: "BBBBBBBBBBBBBBBBBBBBBB" },
    ];
    for (const other of others) {
      expect(failsToDecrypt(() => decryptPendingNote(key, other, blob))).toBe(true);
    }
    expect(decryptPendingNote(key, pending, blob)).toEqual({
      name: "proposal.md",
      text: "proposal",
    });
  });
});

describe("search index", () => {
  it("encrypts a serialized index for the cache and reads it back", () => {
    const key = createWorkspaceKey();
    const workspaceId = newId("ws");
    const serialized = JSON.stringify({ index: { quarterly: [1, 2] } });
    const blob = encryptSearchIndex(key, workspaceId, serialized);
    expect(decryptSearchIndex(key, workspaceId, blob)).toBe(serialized);
    expect(failsToDecrypt(() => decryptSearchIndex(key, newId("ws"), blob))).toBe(true);
    expect(failsToDecrypt(() => decryptSearchIndex(key, workspaceId, blob, "other"))).toBe(true);
  });
});

describe("the note file inside the ciphertext", () => {
  it("carries the file name, refuses bare text, unknown versions and bad names", () => {
    const key = createWorkspaceKey();
    const ref = { workspaceId: newId("ws"), noteId: newId("note") };
    const raw = (plaintext: string) => encryptText(key, plaintext, noteContext(ref));
    expect(decryptNote(key, ref, raw('{"name":"a.md","text":"x","v":1}'))).toEqual({
      name: "a.md",
      text: "x",
    });
    for (const plaintext of [
      // bare text, as development data stored notes before file names existed
      "---\ntitle: Old\n---\nbody",
      '{"title":"no v"}',
      '{"name":"a.md","text":"x","v":2}',
      '{"name":"../a.md","text":"x","v":1}',
      '{"name":"a.txt","text":"x","v":1}',
      '{"name":"a.md","text":"x","v":1,"extra":true}',
    ]) {
      expect(() => decryptNote(key, ref, raw(plaintext))).toThrow(
        expect.objectContaining({ code: "invalid_note" }),
      );
    }
    expect(() => encryptNote(key, ref, { name: "folder/a.md", text: "x" })).toThrow(/folder/);
    // the server sees nothing readable: not the name, not the text
    const blob = encryptNote(key, ref, { name: "secret-plan.md", text: "secret text" });
    expect(String.fromCharCode(...blob)).not.toMatch(/secret/);
  });
});

describe("pending changes and the root folder convention", () => {
  it("never reads a pending change as bare text", () => {
    const key = createWorkspaceKey();
    const pending = {
      workspaceId: newId("ws"),
      noteId: newId("note"),
      folderId: newId("fld"),
      baseVersion: 0,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    const bare = encryptText(key, "just text", pendingContext(pending));
    expect(() => decryptPendingNote(key, pending, bare)).toThrow(
      expect.objectContaining({ code: "invalid_note" }),
    );
  });

  it("allows one root folder, stores folders in the root with no parent, refuses empty renames", () => {
    const world = new World();
    const base = { workspaceId: world.workspaceId };
    const root = prepareFolder(world.signer, world.key, {
      ...base,
      parentId: null,
      name: "",
      rootFolderId: null,
    });
    expect(root.parentId).toBeNull();
    expect(() =>
      prepareFolder(world.signer, world.key, {
        ...base,
        parentId: null,
        name: "",
        rootFolderId: root.id,
      }),
    ).toThrow(RequestValidationError);
    expect(() =>
      prepareFolder(world.signer, world.key, {
        ...base,
        parentId: world.folderId,
        name: "",
        rootFolderId: null,
      }),
    ).toThrow(RequestValidationError);
    const inRoot = prepareFolder(world.signer, world.key, {
      ...base,
      parentId: root.id,
      name: "Policies",
      rootFolderId: root.id,
    });
    expect(inRoot.parentId).toBeNull();
    const update = (details: { folderId: FolderId; name?: string; parentId?: FolderId | null }) =>
      prepareFolderUpdate(world.signer, world.key, { ...base, ...details, rootFolderId: root.id });
    expect(() => update({ folderId: inRoot.id, name: "" })).toThrow(RequestValidationError);
    expect(() => update({ folderId: root.id, name: "Top" })).toThrow(RequestValidationError);
    const moved = update({ folderId: world.folderId, parentId: root.id });
    expect(moved.parentId).toBeNull();
    expect(typeof moved.signature).toBe("string");
    expect(update({ folderId: world.folderId, name: "Renamed" })).not.toHaveProperty("signature");
  });
});

describe("the note size limit", () => {
  it("takes about 4 MiB of note text with room for escaping, and refuses more than 6 MiB", () => {
    const key = createWorkspaceKey();
    const ref = { workspaceId: newId("ws"), noteId: newId("note") };
    // 4 MiB of prose with "quotes": newlines and quotes take two bytes each in the JSON wrapper
    const line = `${'He said "yes". '.repeat(4)}\n`;
    const text = line.repeat(Math.ceil((4 * 1024 * 1024) / line.length));
    expect(encryptNote(key, ref, { name: "big.md", text }).length).toBeGreaterThan(4 * 1024 * 1024);
    const tooBig = "x".repeat(6 * 1024 * 1024);
    expect(() => encryptNote(key, ref, { name: "huge.md", text: tooBig })).toThrow(
      NoteTooLargeError,
    );
    const pending = {
      ...ref,
      folderId: newId("fld"),
      baseVersion: 0,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    expect(() => encryptPendingNote(key, pending, { name: "huge.md", text: tooBig })).toThrow(
      /too large/,
    );
  });
});
