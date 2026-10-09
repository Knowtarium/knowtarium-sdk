import { beforeAll, describe, expect, it } from "vitest";

import {
  createAccountKeys,
  createAgentKeyPair,
  createWorkspaceKey,
  isCryptoError,
  ready,
  rotateWorkspaceKey,
  toBase64Url,
  wrapAndSignWorkspaceKey,
} from "../../crypto/index.js";
import { isVaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { wrappedRecord } from "../testing/wrapped.js";
import { checkPreloginKdf } from "./account.js";
import { openWorkspaceKeyring } from "./keys.js";
import { MemoryTrustStorage, TrustState } from "./trust.js";

beforeAll(ready);

function trust(): TrustState {
  return new TrustState(new MemoryTrustStorage());
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (isVaultError(error) || isCryptoError(error)) return error.code;
    throw error;
  }
  return undefined;
}

function owner() {
  const account = createAccountKeys();
  const accountId = newId("acc");
  const workspaceId = newId("ws");
  const first = createWorkspaceKey();
  const second = rotateWorkspaceKey(first);
  const wrap = (key = first, recipient = account.encryption.publicKey) =>
    wrappedRecord(
      workspaceId,
      { kind: "account", accountId },
      wrapAndSignWorkspaceKey(key, recipient, {
        accountId,
        workspaceId,
        signing: account.signing,
        holder: "account",
      }),
      key.generation,
    );
  const options = (state = trust()) => ({
    workspaceId,
    recipient: account.encryption,
    ownerSigningPublicKey: account.signing.publicKey,
    ownerAccountId: accountId,
    trust: state,
  });
  return { account, accountId, workspaceId, first, second, wrap, options };
}

describe("wrapped keys", () => {
  it("opens every verified generation and tracks the newest", async () => {
    const { first, second, wrap, options } = owner();
    const state = trust();
    const keyring = await openWorkspaceKeyring([wrap(first), wrap(second)], options(state));
    expect(keyring.current.generation).toBe(2);
    expect(keyring.get(1)?.key).toEqual(first.key);
    expect(await state.keyGeneration(options().workspaceId)).toBe(2);
  });

  it("never trusts a copy the owner didn't sign", async () => {
    const { wrap, options } = owner();
    const stranger = createAccountKeys();
    const code = await codeOf(
      openWorkspaceKeyring([wrap()], {
        ...options(),
        ownerSigningPublicKey: stranger.signing.publicKey,
      }),
    );
    expect(code).toBe("untrusted_signature");
  });

  it("refuses a copy sealed for someone else", async () => {
    const { first, wrap, options } = owner();
    const code = await codeOf(
      openWorkspaceKeyring([wrap(first, createAgentKeyPair().publicKey)], options()),
    );
    expect(code).toBe("untrusted_signature");
  });

  it("refuses a record whose generation field disagrees with its signature", async () => {
    const { wrap, options } = owner();
    const code = await codeOf(openWorkspaceKeyring([{ ...wrap(), keyGeneration: 2 }], options()));
    expect(code).toBe("untrusted_signature");
  });

  it("refuses when the server withholds the newest generation", async () => {
    const { first, second, wrap, options } = owner();
    const state = trust();
    await openWorkspaceKeyring([wrap(first), wrap(second)], options(state));
    expect(await codeOf(openWorkspaceKeyring([wrap(first)], options(state)))).toBe("rollback");
    expect(await codeOf(state.assertWriteGeneration(options().workspaceId, 1))).toBe("rollback");
    await state.assertWriteGeneration(options().workspaceId, 2);
  });

  it("refuses an empty answer", async () => {
    const { options } = owner();
    expect(await codeOf(openWorkspaceKeyring([], options()))).toBe("missing_key");
  });
});

describe("high-water marks", () => {
  it("refuses a note version below the highest seen", async () => {
    const state = trust();
    const workspaceId = newId("ws");
    const noteId = newId("note");
    await state.acceptNoteVersion(workspaceId, noteId, 1);
    await state.acceptNoteVersion(workspaceId, noteId, 3);
    await state.acceptNoteVersion(workspaceId, noteId, 3);
    expect(await codeOf(state.acceptNoteVersion(workspaceId, noteId, 2))).toBe("rollback");
    expect(await state.noteVersion(workspaceId, noteId)).toBe(3);
  });

  it("keeps marks in the caller's storage", async () => {
    const storage = new MemoryTrustStorage();
    const workspaceId = newId("ws");
    const noteId = newId("note");
    await new TrustState(storage).acceptNoteVersion(workspaceId, noteId, 5);
    expect(await codeOf(new TrustState(storage).acceptNoteVersion(workspaceId, noteId, 4))).toBe(
      "rollback",
    );
  });

  it("serializes concurrent checks", async () => {
    const state = trust();
    const workspaceId = newId("ws");
    const noteId = newId("note");
    const results = await Promise.allSettled([
      state.acceptNoteVersion(workspaceId, noteId, 4),
      state.acceptNoteVersion(workspaceId, noteId, 2),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  });

  it("pins the account keys and the owner key", async () => {
    const state = trust();
    const accountId = newId("acc");
    const keys = {
      box: toBase64Url(new Uint8Array(32).fill(1)),
      sign: toBase64Url(new Uint8Array(32).fill(2)),
    };
    await state.pinAccountKeys(accountId, keys);
    await state.pinAccountKeys(accountId, keys);
    const swapped = { box: keys.box, sign: toBase64Url(new Uint8Array(32).fill(3)) };
    expect(await codeOf(state.pinAccountKeys(accountId, swapped))).toBe("pin_mismatch");

    const workspaceId = newId("ws");
    await state.pinOwnerKey(workspaceId, keys.sign);
    expect(await codeOf(state.pinOwnerKey(workspaceId, swapped.sign))).toBe("pin_mismatch");
    expect(await state.ownerKey(workspaceId)).toHaveLength(32);
  });

  it("pins one agent policy hash per revision, loading marks stored before pins", async () => {
    const storage = new MemoryTrustStorage();
    // a mark from before pins: the floor alone, a number
    await storage.set("workspace/ws_1/agent-policy", "3");
    const marks = new TrustState(storage);
    expect(await marks.agentPolicyRevision("ws_1")).toBe(3);
    expect(await marks.agentPolicySha256("ws_1", 3)).toBeUndefined();
    expect(await marks.acceptAgentPolicy("ws_1", 3, "hash-a")).toBe(true);
    expect(await marks.acceptAgentPolicy("ws_1", 3, "hash-a")).toBe(true);
    // another hash at a pinned revision: refused, nothing changes
    expect(await marks.acceptAgentPolicy("ws_1", 3, "hash-b")).toBe(false);
    expect(await marks.agentPolicySha256("ws_1", 3)).toBe("hash-a");
    // an old revision read on purpose pins without moving the floor
    expect(await marks.acceptAgentPolicy("ws_1", 1, "hash-c", { raiseFloor: false })).toBe(true);
    expect(await marks.agentPolicyRevision("ws_1")).toBe(3);
    expect(await marks.acceptAgentPolicy("ws_1", 1, "hash-d", { raiseFloor: false })).toBe(false);
    // the highest revision verified counts a pin above the floor
    expect(await marks.acceptAgentPolicy("ws_1", 4, "hash-f", { raiseFloor: false })).toBe(true);
    expect(await marks.agentPolicyRevision("ws_1")).toBe(3);
    expect(await marks.highestAgentPolicyRevision("ws_1")).toBe(4);
    // a newer one raises the floor, which stays a plain number for older readers
    expect(await marks.acceptAgentPolicy("ws_1", 5, "hash-e")).toBe(true);
    expect(await storage.get("workspace/ws_1/agent-policy")).toBe("5");
    // other workspaces are their own
    expect(await marks.acceptAgentPolicy("ws_2", 3, "hash-b")).toBe(true);
    // the pins survive a new TrustState on the same storage
    expect(await new TrustState(storage).agentPolicySha256("ws_1", 5)).toBe("hash-e");
  });

  it("keeps the hashes of the highest 20 agent policy revisions", async () => {
    const marks = trust();
    for (let revision = 1; revision <= 25; revision += 1) {
      expect(await marks.acceptAgentPolicy("ws_1", revision, `hash-${String(revision)}`)).toBe(
        true,
      );
    }
    expect(await marks.agentPolicySha256("ws_1", 5)).toBeUndefined();
    expect(await marks.agentPolicySha256("ws_1", 6)).toBe("hash-6");
    expect(await marks.agentPolicySha256("ws_1", 25)).toBe("hash-25");
    // one older than every pin kept isn't pinned, the newest stays
    expect(await marks.acceptAgentPolicy("ws_1", 2, "hash-x", { raiseFloor: false })).toBe(true);
    expect(await marks.agentPolicySha256("ws_1", 2)).toBeUndefined();
    expect(await marks.acceptAgentPolicy("ws_1", 25, "hash-x")).toBe(false);
  });

  it("reads damaged agent policy pins as none", async () => {
    const storage = new MemoryTrustStorage();
    await storage.set("workspace/ws_1/agent-policy-pins", JSON.stringify({ revision: 1 }));
    const marks = new TrustState(storage);
    expect(await marks.agentPolicySha256("ws_1", 1)).toBeUndefined();
    expect(await marks.acceptAgentPolicy("ws_1", 1, "hash-a")).toBe(true);
  });

  it("refuses weaker KDF parameters than the strongest seen", async () => {
    const state = trust();
    const salt = toBase64Url(new Uint8Array(16).fill(4));
    const strong = {
      algorithm: "argon2id13",
      salt,
      opsLimit: 4,
      memLimitBytes: 128 << 20,
    } as const;
    expect(await checkPreloginKdf(state, "a@example.com", strong)).toMatchObject({
      memLimit: 128 << 20,
    });
    await state.recordKdfParams("a@example.com", strong);
    const weaker = { ...strong, opsLimit: 3 };
    expect(await codeOf(checkPreloginKdf(state, "a@example.com", weaker))).toBe("rollback");
    const belowFloor = { ...strong, opsLimit: 1 };
    expect(await codeOf(checkPreloginKdf(state, "b@example.com", belowFloor))).toBe(
      "invalid_kdf_params",
    );
    await checkPreloginKdf(state, "a@example.com", { ...strong, opsLimit: 5 });
  });
});
