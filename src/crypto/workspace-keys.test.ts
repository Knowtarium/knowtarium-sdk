import { beforeAll, describe, expect, it } from "vitest";

import { decryptText, encryptText } from "./envelope.js";
import { createAccountKeys, createAgentKeyPair } from "./keys.js";
import { ready } from "./sodium.js";
import { createKeyring, createWorkspaceKey, rotateWorkspaceKey } from "./workspace-keys.js";
import { unwrapWorkspaceKeyUnverified, wrapWorkspaceKey } from "./wrap.js";

beforeAll(ready);

const NOTE = { kind: "note", workspaceId: "ws_1", id: "note_1" } as const;

describe("workspace keys for recipients", () => {
  it("wraps a workspace key for the account and for an agent", () => {
    const account = createAccountKeys();
    const agent = createAgentKeyPair();
    const key = createWorkspaceKey();
    expect(key).toMatchObject({ generation: 1 });
    expect(key.key).toHaveLength(32);

    for (const recipient of [account.encryption, agent]) {
      const wrapped = wrapWorkspaceKey(key, recipient.publicKey, "ws_1");
      expect(unwrapWorkspaceKeyUnverified(wrapped, recipient, "ws_1")).toEqual(key);
    }
  });

  it("can't be opened by anyone else", () => {
    const key = createWorkspaceKey();
    const wrapped = wrapWorkspaceKey(key, createAgentKeyPair().publicKey, "ws_1");
    expect(() => unwrapWorkspaceKeyUnverified(wrapped, createAgentKeyPair(), "ws_1")).toThrow(
      expect.objectContaining({ code: "decryption_failed" }),
    );
  });

  it("is bound to its workspace", () => {
    const agent = createAgentKeyPair();
    const wrapped = wrapWorkspaceKey(createWorkspaceKey(), agent.publicKey, "ws_1");
    expect(() => unwrapWorkspaceKeyUnverified(wrapped, agent, "ws_2")).toThrow(
      expect.objectContaining({ code: "key_mismatch" }),
    );
  });

  it("detects tampering", () => {
    const agent = createAgentKeyPair();
    const wrapped = wrapWorkspaceKey(createWorkspaceKey(), agent.publicKey, "ws_1");
    for (const index of [0, 31, 32, 50, wrapped.length - 1]) {
      const tampered = wrapped.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      expect(() => unwrapWorkspaceKeyUnverified(tampered, agent, "ws_1")).toThrow(
        expect.objectContaining({ code: "decryption_failed" }),
      );
    }
  });

  it("revokes an agent: rotate, re-wrap for the rest, old blobs stay readable", () => {
    const account = createAccountKeys();
    const agent = createAgentKeyPair();
    const first = createWorkspaceKey();
    const oldBlob = encryptText(first, "before", NOTE);

    // revoke: the agent's copy is deleted server-side, and new writes use generation 2
    const second = rotateWorkspaceKey(first);
    const forAccount = [first, second].map((key) =>
      wrapWorkspaceKey(key, account.encryption.publicKey, "ws_1"),
    );
    const newBlob = encryptText(second, "after", NOTE);

    const keyring = createKeyring(
      forAccount.map((wrapped) =>
        unwrapWorkspaceKeyUnverified(wrapped, account.encryption, "ws_1"),
      ),
    );
    expect(keyring.current.generation).toBe(2);
    expect(decryptText(keyring, oldBlob, NOTE)).toBe("before");
    expect(decryptText(keyring, newBlob, NOTE)).toBe("after");

    // the revoked agent kept generation 1 and can't read what comes next
    const agentKey = unwrapWorkspaceKeyUnverified(
      wrapWorkspaceKey(first, agent.publicKey, "ws_1"),
      agent,
      "ws_1",
    );
    expect(decryptText(agentKey, oldBlob, NOTE)).toBe("before");
    expect(() => decryptText(agentKey, newBlob, NOTE)).toThrow(
      expect.objectContaining({ code: "key_generation_mismatch" }),
    );
    expect(() => decryptText({ generation: 2, key: agentKey.key }, newBlob, NOTE)).toThrow(
      expect.objectContaining({ code: "decryption_failed" }),
    );
  });
});
