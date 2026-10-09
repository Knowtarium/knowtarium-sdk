import { beforeAll, describe, expect, it } from "vitest";

import { toBase64Url } from "./encoding.js";
import { recipientsHash, workspaceKeyCommitment } from "./hash.js";
import {
  type AccountKeys,
  type BoxKeyPair,
  createAccountKeys,
  createAgentKeyPair,
} from "./keys.js";
import { type SignedEnvelope, signEnvelope } from "./signed-envelope.js";
import {
  signKeyGeneration,
  signWrappedKey,
  unwrapSignedWorkspaceKey,
  verifyKeyGeneration,
  verifyWrappedKey,
  wrapAndSignWorkspaceKey,
} from "./signed-wrap.js";
import { ready } from "./sodium.js";
import { createWorkspaceKey, rotateWorkspaceKey, type WorkspaceKey } from "./workspace-keys.js";
import { wrapWorkspaceKey } from "./wrap.js";

beforeAll(ready);

describe("owner-signed wrapped keys", () => {
  let owner: AccountKeys;
  let server: AccountKeys;
  let agent: BoxKeyPair;
  let key: WorkspaceKey;
  const ids = { accountId: "usr_owner", workspaceId: "ws_1", holder: "account" };
  const expectation = () => ({
    ownerSigningPublicKey: owner.signing.publicKey,
    ownerAccountId: ids.accountId,
    workspaceId: ids.workspaceId,
  });
  beforeAll(() => {
    owner = createAccountKeys();
    server = createAccountKeys();
    agent = createAgentKeyPair();
    key = createWorkspaceKey();
  });

  it("wraps, signs, verifies and unwraps for the account and an agent", () => {
    for (const recipient of [owner.encryption, agent]) {
      const signedKey = wrapAndSignWorkspaceKey(key, recipient.publicKey, {
        ...ids,
        signing: owner.signing,
      });
      expect(signedKey.signed.envelope).toMatchObject({
        type: "wrapped_key",
        ...ids,
        recipient: toBase64Url(recipient.publicKey),
        generation: key.generation,
      });
      expect(unwrapSignedWorkspaceKey(signedKey, recipient, expectation())).toEqual(key);
    }
  });

  it("refuses a key the server wrapped and signed itself", () => {
    const planted = createWorkspaceKey();
    const signedKey = wrapAndSignWorkspaceKey(planted, agent.publicKey, {
      ...ids,
      signing: server.signing,
    });
    expect(() => unwrapSignedWorkspaceKey(signedKey, agent, expectation())).toThrow(
      expect.objectContaining({ code: "invalid_signature" }),
    );
  });

  it("refuses the owner's signature moved onto other wrapped bytes", () => {
    const genuine = wrapAndSignWorkspaceKey(key, agent.publicKey, {
      ...ids,
      signing: owner.signing,
    });
    const planted = wrapWorkspaceKey(createWorkspaceKey(), agent.publicKey, ids.workspaceId);
    expect(() =>
      unwrapSignedWorkspaceKey({ ...genuine, wrapped: planted }, agent, expectation()),
    ).toThrow(expect.objectContaining({ code: "invalid_signature" }));
  });

  it("refuses a signature for another recipient, workspace or owner", () => {
    const forAccount = wrapAndSignWorkspaceKey(key, owner.encryption.publicKey, {
      ...ids,
      signing: owner.signing,
    });
    const check = (signed: SignedEnvelope, expected: Parameters<typeof verifyWrappedKey>[2]) =>
      verifyWrappedKey(forAccount.wrapped, signed, expected);
    const base = { ...expectation(), recipientPublicKey: owner.encryption.publicKey };
    expect(check(forAccount.signed, base)).toBe(true);
    expect(check(forAccount.signed, { ...base, recipientPublicKey: agent.publicKey })).toBe(false);
    expect(check(forAccount.signed, { ...base, workspaceId: "ws_2" })).toBe(false);
    expect(check(forAccount.signed, { ...base, ownerAccountId: "usr_other" })).toBe(false);
    // the signed holder binds the copy to who holds it
    expect(check(forAccount.signed, { ...base, holder: "account" })).toBe(true);
    expect(check(forAccount.signed, { ...base, holder: "tok_0000000000000000000000000a" })).toBe(
      false,
    );
    expect(
      check(forAccount.signed, { ...base, ownerSigningPublicKey: server.signing.publicKey }),
    ).toBe(false);
    // an owner signature of another type over the same fields doesn't count
    const { accountId, workspaceId, generation, createdAt } = forAccount.signed.envelope;
    const retyped = signEnvelope(
      {
        type: "key_generation",
        accountId,
        workspaceId,
        generation: generation ?? 1,
        recipientsHash: recipientsHash([owner.encryption.publicKey]),
        keyCommitment: workspaceKeyCommitment(key, workspaceId),
        createdAt,
      },
      owner.signing,
    );
    expect(check(retyped, base)).toBe(false);
    expect(check({ ...retyped, envelope: forAccount.signed.envelope }, base)).toBe(false);
    expect(() =>
      signEnvelope({ ...forAccount.signed.envelope, type: "key_generation" }, owner.signing),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("refuses a generation that doesn't match the box", () => {
    const next = rotateWorkspaceKey(key);
    const wrapped = wrapWorkspaceKey(key, agent.publicKey, ids.workspaceId);
    const signed = signWrappedKey(
      wrapped,
      { ...ids, recipientPublicKey: agent.publicKey, generation: next.generation },
      owner.signing,
    );
    const signedGeneration = signKeyGeneration(
      { ...ids, recipients: [agent.publicKey], key: next },
      owner.signing,
    );
    expect(() =>
      unwrapSignedWorkspaceKey({ wrapped, signed, signedGeneration }, agent, expectation()),
    ).toThrow(expect.objectContaining({ code: "invalid_signature" }));
  });
});

describe("owner-signed key generations", () => {
  let owner: AccountKeys;
  let server: AccountKeys;
  let agent: BoxKeyPair;
  let key: WorkspaceKey;
  const ids = { accountId: "usr_owner", workspaceId: "ws_1", holder: "account" };
  const expectation = () => ({
    ownerSigningPublicKey: owner.signing.publicKey,
    ownerAccountId: ids.accountId,
    workspaceId: ids.workspaceId,
  });
  beforeAll(() => {
    owner = createAccountKeys();
    server = createAccountKeys();
    agent = createAgentKeyPair();
    key = createWorkspaceKey();
  });

  it("signs one generation for every recipient", () => {
    const signedGeneration = signKeyGeneration(
      { ...ids, recipients: [agent.publicKey], key },
      owner.signing,
    );
    expect(signedGeneration.envelope).toMatchObject({
      type: "key_generation",
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
    });
    const owned = { ...ids, signing: owner.signing, signedGeneration };
    const forAccount = wrapAndSignWorkspaceKey(key, owner.encryption.publicKey, owned);
    const forAgent = wrapAndSignWorkspaceKey(key, agent.publicKey, owned);
    expect(forAccount.signedGeneration).toBe(signedGeneration);
    expect(forAgent.signedGeneration).toBe(signedGeneration);
    expect(unwrapSignedWorkspaceKey(forAgent, agent, expectation())).toEqual(key);
  });

  it("verifies only the owner's signature for this workspace and generation", () => {
    const signed = signKeyGeneration(
      { ...ids, recipients: [agent.publicKey], key: { generation: 2, key: key.key } },
      owner.signing,
    );
    const expected = { ...expectation(), generation: 2 };
    expect(verifyKeyGeneration(signed, expected)).toBe(true);
    expect(verifyKeyGeneration(signed, { ...expected, generation: 3 })).toBe(false);
    expect(verifyKeyGeneration(signed, { ...expected, workspaceId: "ws_2" })).toBe(false);
    expect(verifyKeyGeneration(signed, { ...expected, ownerAccountId: "usr_other" })).toBe(false);
    // the generation commits to its key
    expect(verifyKeyGeneration(signed, { ...expected, key: { generation: 2, key: key.key } })).toBe(
      true,
    );
    expect(
      verifyKeyGeneration(signed, { ...expected, key: { generation: 2, key: new Uint8Array(32) } }),
    ).toBe(false);
    const byServer = signKeyGeneration(
      { ...ids, recipients: [agent.publicKey], key: { generation: 2, key: key.key } },
      server.signing,
    );
    expect(verifyKeyGeneration(byServer, expected)).toBe(false);
  });

  it("refuses a key that isn't the one the generation commits to", () => {
    // two owner-signed key sets for one generation: the copy of one with the other's signature
    const other = { generation: key.generation, key: createWorkspaceKey().key };
    const otherGeneration = signKeyGeneration(
      { ...ids, recipients: [agent.publicKey], key: other },
      owner.signing,
    );
    const genuine = wrapAndSignWorkspaceKey(key, agent.publicKey, {
      ...ids,
      signing: owner.signing,
    });
    expect(() =>
      unwrapSignedWorkspaceKey(
        { ...genuine, signedGeneration: otherGeneration },
        agent,
        expectation(),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_signature" }));
    expect(() =>
      wrapAndSignWorkspaceKey(key, agent.publicKey, {
        ...ids,
        signing: owner.signing,
        signedGeneration: otherGeneration,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("refuses to wrap with another generation's signature", () => {
    const other = signKeyGeneration(
      { ...ids, recipients: [agent.publicKey], key: rotateWorkspaceKey(key) },
      owner.signing,
    );
    expect(() =>
      wrapAndSignWorkspaceKey(key, agent.publicKey, {
        ...ids,
        signing: owner.signing,
        signedGeneration: other,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("refuses a generation without a valid owner signature", () => {
    const genuine = wrapAndSignWorkspaceKey(key, agent.publicKey, {
      ...ids,
      signing: owner.signing,
    });
    const forged = [
      signKeyGeneration({ ...ids, recipients: [agent.publicKey], key }, server.signing),
      signKeyGeneration(
        { ...ids, recipients: [agent.publicKey], key: rotateWorkspaceKey(key) },
        owner.signing,
      ),
      signKeyGeneration(
        { ...ids, recipients: [agent.publicKey], workspaceId: "ws_2", key },
        owner.signing,
      ),
      signKeyGeneration(
        {
          ...ids,
          recipients: [agent.publicKey],
          accountId: "usr_other",
          key,
        },
        owner.signing,
      ),
      { ...genuine.signedGeneration, signature: genuine.signed.signature },
      genuine.signed,
    ];
    for (const signedGeneration of forged) {
      expect(() =>
        unwrapSignedWorkspaceKey({ ...genuine, signedGeneration }, agent, expectation()),
      ).toThrow(expect.objectContaining({ code: "invalid_signature" }));
    }
  });
});
