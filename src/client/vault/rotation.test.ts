import { beforeAll, describe, expect, it } from "vitest";

import {
  type BoxKeyPair,
  ciphertextSha256,
  createAgentKeyPair,
  createWorkspaceKey,
  fromBase64Url,
  ready,
  signEnvelope,
  signKeyGeneration,
  unwrapSignedWorkspaceKey,
  verifyKeyGeneration,
  wrapAndSignWorkspaceKey,
} from "../../crypto/index.js";
import {
  type ListKeysResponse,
  type RecipientKey,
  routes,
  type TokenId,
  type WrappedWorkspaceKey,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { isVaultError, RequestValidationError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { World } from "../testing/world.js";
import { wrappedRecord } from "../testing/wrapped.js";
import {
  createKeyProvider,
  MemoryTrustStorage,
  openWorkspaceKeyring,
  prepareConnectGeneration,
  prepareRotation,
  revokeAndRotate,
  rotateWorkspace,
  rotationRecipients,
  signRevocation,
  TrustState,
} from "./index.js";

beforeAll(ready);

/** The owner's view of who holds the world's current generation. */
async function ownerView(world: World) {
  const { data } = await world.web().api.call(routes.listKeys);
  return { recipients: data.recipients ?? [], revocations: data.revocations ?? [] };
}

function expectation(world: World, generation = 1) {
  return {
    workspaceId: world.workspaceId,
    generation,
    ownerSigningPublicKey: world.account.signing.publicKey,
    ownerAccountId: world.accountId,
    ownerBoxPublicKey: world.account.encryption.publicKey,
  };
}

/** The owner's rotation flow on a fresh browser of the world's account. */
function ownerFlow(world: World, trust = new TrustState(new MemoryTrustStorage())) {
  const web = world.web();
  const keys = createKeyProvider(web.api, {
    workspaceId: world.workspaceId,
    recipient: world.account.encryption,
    ownerSigningPublicKey: world.account.signing.publicKey,
    ownerAccountId: world.accountId,
    trust,
  });
  return {
    api: web.api,
    flow: {
      workspaceId: world.workspaceId,
      signer: world.signer,
      ownerBoxPublicKey: world.account.encryption.publicKey,
      keys,
      trust,
    },
  };
}

/** `api`, with `edit` applied to every `listKeys` answer (a server rewriting what it lists). */
function rewriteListKeys(api: ApiClient, edit: (data: ListKeysResponse) => ListKeysResponse) {
  const rewritten = Object.create(api) as ApiClient;
  const call = api.call.bind(api);
  rewritten.call = (async (route: unknown, input: unknown) => {
    const answer = (await call(route as never, input as never)) as { data: unknown };
    return route === routes.listKeys
      ? { ...answer, data: edit(answer.data as ListKeysResponse) }
      : answer;
  }) as ApiClient["call"];
  return rewritten;
}

/**
 * Re-signs the world's generation 1 for the account, its agent and a second agent, and stores the
 * second agent's copy: the server then lists two agents' copies.
 */
function addSecondAgent(world: World): { tokenId: TokenId; agent: BoxKeyPair } {
  const second = { tokenId: newId("tok"), agent: createAgentKeyPair() };
  const signedGeneration = signKeyGeneration(
    {
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      key: world.key,
      recipients: [
        world.account.encryption.publicKey,
        world.agent.publicKey,
        second.agent.publicKey,
      ],
    },
    world.account.signing,
  );
  const owner = {
    accountId: world.accountId,
    workspaceId: world.workspaceId,
    signing: world.account.signing,
    signedGeneration,
  };
  const resigned = (record: WrappedWorkspaceKey): WrappedWorkspaceKey => ({
    ...record,
    signedGeneration: {
      envelope: signedGeneration.envelope,
      signature: signedGeneration.signature,
    } as WrappedWorkspaceKey["signedGeneration"],
  });
  world.server.sessionKeys = world.server.sessionKeys.map(resigned);
  world.server.agentKeys = [
    ...world.server.agentKeys.map(resigned),
    wrappedRecord(
      world.workspaceId,
      { kind: "token", tokenId: second.tokenId },
      wrapAndSignWorkspaceKey(world.key, second.agent.publicKey, {
        ...owner,
        holder: second.tokenId,
      }),
      1,
    ),
  ];
  return second;
}

/** Swaps the two agents' token labels in the listed copies. */
function swapLabels(a: TokenId, b: TokenId) {
  return (data: ListKeysResponse): ListKeysResponse => ({
    ...data,
    recipients: (data.recipients ?? []).map((record): RecipientKey => {
      if (record.recipient.kind !== "token") return record;
      const { tokenId } = record.recipient;
      const swapped = tokenId === a ? b : tokenId === b ? a : tokenId;
      return { ...record, recipient: { kind: "token", tokenId: swapped } };
    }),
  });
}

describe("rotation recipients", () => {
  it("keeps the owner-signed set of the generation, without excluded keys", async () => {
    const world = new World();
    const { recipients, revocations } = await ownerView(world);
    const all = rotationRecipients(recipients, revocations, expectation(world));
    expect(all.recipients.map((entry) => entry.publicKey)).toEqual(
      expect.arrayContaining([world.agent.publicKey, world.account.encryption.publicKey]),
    );
    const without = rotationRecipients(recipients, revocations, {
      ...expectation(world),
      exclude: [world.agent.publicKey],
    });
    expect(without.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
    expect(without.excluded.map((entry) => entry.publicKey)).toEqual([world.agent.publicKey]);
  });

  it("refuses a key the owner didn't sign into the generation", async () => {
    const world = new World();
    const { recipients } = await ownerView(world);
    // a genuine-looking copy for another key, even with the owner's wrapped_key signature
    const intruder = createAgentKeyPair();
    const tokenId = newId("tok");
    const extra = wrapAndSignWorkspaceKey(world.key, intruder.publicKey, {
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      signing: world.account.signing,
      holder: tokenId,
      signedGeneration: signKeyGeneration(
        {
          accountId: world.accountId,
          workspaceId: world.workspaceId,
          key: world.key,
          recipients: [intruder.publicKey],
        },
        world.account.signing,
      ),
    });
    const added: RecipientKey = {
      ...wrappedRecord(world.workspaceId, { kind: "token", tokenId }, extra, 1),
      revokedAt: null,
    };
    let refused: unknown = null;
    try {
      rotationRecipients([...recipients, added], [], expectation(world));
    } catch (error) {
      refused = error;
    }
    expect(isVaultError(refused, "untrusted_signature")).toBe(true);
  });

  it("refuses a copy listed under another holder than the owner signed", async () => {
    const world = new World();
    const { recipients } = await ownerView(world);
    const relabelled = recipients.map((record) =>
      record.recipient.kind === "token"
        ? { ...record, recipient: { kind: "account" as const, accountId: world.accountId } }
        : record,
    );
    expect(() => rotationRecipients(relabelled, [], expectation(world))).toThrow(/holder/);
    const retokened = recipients.map((record) =>
      record.recipient.kind === "token"
        ? { ...record, recipient: { kind: "token" as const, tokenId: newId("tok") } }
        : record,
    );
    expect(() => rotationRecipients(retokened, [], expectation(world))).toThrow(/holder/);
  });

  it("refuses two agents' labels swapped, so the right key is revoked", async () => {
    const world = new World();
    const second = addSecondAgent(world);
    const { recipients } = await ownerView(world);
    const honest = rotationRecipients(recipients, [], expectation(world)).recipients;
    const byToken = new Map(
      honest.flatMap((entry) =>
        entry.recipient.kind === "token" ? [[entry.recipient.tokenId, entry.publicKey]] : [],
      ),
    );
    expect(byToken.get(world.tokenId)).toEqual(world.agent.publicKey);
    expect(byToken.get(second.tokenId)).toEqual(second.agent.publicKey);

    const swapped = swapLabels(world.tokenId, second.tokenId)({ workspaceKeys: [], recipients });
    expect(() => rotationRecipients(swapped.recipients ?? [], [], expectation(world))).toThrow(
      /holder/,
    );

    // end to end: revoking the first agent through a server that swaps the labels revokes nothing
    const { api, flow } = ownerFlow(world);
    const lying = rewriteListKeys(api, swapLabels(world.tokenId, second.tokenId));
    const refused = await revokeAndRotate(lying, { ...flow, tokenId: world.tokenId }).catch(
      (error: unknown) => error,
    );
    expect(isVaultError(refused, "untrusted_signature")).toBe(true);
    expect(world.server.tokenRevoked).toBe(false);
    expect(world.server.revocations).toHaveLength(0);
    expect(world.server.rotations).toBe(0);
  });

  it("only takes the generation from the caller's own keyring", async () => {
    const world = new World();
    const { recipients } = await ownerView(world);
    // asked about generation 2 (the keyring's), the server's generation 1 copies don't count
    expect(() => rotationRecipients(recipients, [], expectation(world, 2))).toThrow();
  });
});

describe("revoking and rotating in one flow", () => {
  it("revokes with a signed record and wraps the next generation without the agent", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    const result = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId });
    expect(result.generation).toBe(2);
    expect(result.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
    expect(world.server.tokenRevoked).toBe(true);
    expect(world.server.revocations).toHaveLength(1);
    expect((await flow.keys.get()).current.generation).toBe(2);
    expect(await flow.trust.revocations(world.workspaceId)).toEqual([
      { tokenId: world.tokenId, publicKey: world.agent.publicKey, pending: false },
    ]);

    // a replay of the revoked agent's old, owner-signed copy can't get it into generation 3
    const { recipients, revocations } = await ownerView(world);
    const replayed = [
      ...recipients,
      ...world.server.agentKeys.map((record) => ({ ...record, keyGeneration: 2, revokedAt: null })),
    ];
    expect(() => rotationRecipients(replayed, revocations, expectation(world, 2))).toThrow();
    // and with an honest list, the signed revocation alone keeps the agent out
    const next = rotationRecipients(recipients, revocations, expectation(world, 2));
    expect(next.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
  });

  it("resumes after a failure between the revoke and the rotation, revoking only once", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    world.server.tamper.refuse = (route) =>
      route === "rotateWorkspaceKey" ? "unavailable" : undefined;
    const failed = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId }).catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(world.server.revocations).toHaveLength(1);
    expect(world.server.rotations).toBe(0);
    expect(await flow.trust.revocations(world.workspaceId)).toMatchObject([
      { tokenId: world.tokenId, pending: true },
    ]);
    delete world.server.tamper.refuse;

    const revokes = () =>
      world.server.requests.filter(({ init }) => init.method === "DELETE").length;
    const before = revokes();
    const result = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId });
    expect(revokes()).toBe(before);
    expect(world.server.revocations).toHaveLength(1);
    expect(result.generation).toBe(2);
    expect(result.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
    expect((await flow.trust.revocations(world.workspaceId))[0]?.pending).toBe(false);
    // running it again is a no-op: the agent holds no copy of generation 2
    const again = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId });
    expect(again.generation).toBe(2);
    expect(world.server.rotations).toBe(1);
  });

  it("leaves a remembered revocation out of every later rotation, even when the server forgets it", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    // revoked from this device, but the server lost both the record and the mark
    await flow.trust.rememberRevocation(world.workspaceId, {
      tokenId: world.tokenId,
      publicKey: world.agent.publicKey,
    });
    const result = await rotateWorkspace(api, flow);
    expect(result.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
    expect(result.excluded.map((entry) => entry.publicKey)).toEqual([world.agent.publicKey]);
  });

  it("excludes a key with a signed revocation even when the server forgets to mark it", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    // revoke (signed), but stop before rotating: generation 1 still lists the agent
    world.server.tamper.refuse = (route) =>
      route === "rotateWorkspaceKey" ? "unavailable" : undefined;
    await revokeAndRotate(api, { ...flow, tokenId: world.tokenId }).catch(() => undefined);
    delete world.server.tamper.refuse;
    const { recipients, revocations } = await ownerView(world);
    const unmarked = recipients.map((record) => ({ ...record, revokedAt: null }));
    const next = rotationRecipients(unmarked, revocations, expectation(world));
    expect(next.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
  });

  it("a rotation that still wraps for the revoked token is refused", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    const { recipients, revocations } = await ownerView(world);
    const everyone = rotationRecipients(recipients, revocations, expectation(world)).recipients;
    await api.call(routes.revokeToken, { params: { tokenId: world.tokenId } });
    const { request } = prepareRotation(world.signer, {
      workspaceId: world.workspaceId,
      current: (await flow.keys.get()).current,
      recipients: everyone,
    });
    const refused = await api
      .call(routes.rotateWorkspaceKey, {
        params: { workspaceId: world.workspaceId },
        body: request,
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(world.server.rotations).toBe(0);
  });
});

describe("equivocation", () => {
  it("refuses a smaller owner-signed set for a generation this device saw", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    // this device saw generation 1 held by the account and the agent
    await flow.trust.acceptGenerationSet(world.workspaceId, 1, [
      world.account.encryption.publicKey,
      world.agent.publicKey,
    ]);
    // the server shows an owner-signed set of generation 1 without the agent (an older signature,
    // or one from another device): a rotation from it would drop the agent unseen
    const accountOnly = signKeyGeneration(
      {
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        key: world.key,
        recipients: [world.account.encryption.publicKey],
      },
      world.account.signing,
    );
    const narrowed = rewriteListKeys(api, (data) => ({
      ...data,
      recipients: (data.recipients ?? [])
        .filter((record) => record.recipient.kind === "account")
        .map((record) => ({
          ...record,
          signedGeneration: {
            envelope: accountOnly.envelope,
            signature: accountOnly.signature,
          } as RecipientKey["signedGeneration"],
        })),
    }));
    const refused = await rotateWorkspace(narrowed, flow).catch((error: unknown) => error);
    expect(isVaultError(refused, "rollback")).toBe(true);
    expect(world.server.rotations).toBe(0);
  });

  it("refuses an older generation, and lets a set grow within one", async () => {
    const trust = new TrustState(new MemoryTrustStorage());
    const [a, b, c] = [createAgentKeyPair(), createAgentKeyPair(), createAgentKeyPair()];
    await trust.acceptGenerationSet("ws_1", 2, [a.publicKey, b.publicKey]);
    // connecting an agent re-signs the generation with one more key
    await trust.acceptGenerationSet("ws_1", 2, [a.publicKey, b.publicKey, c.publicKey]);
    await expect(trust.acceptGenerationSet("ws_1", 1, [a.publicKey])).rejects.toMatchObject({
      code: "rollback",
    });
    await expect(
      trust.acceptGenerationSet("ws_1", 2, [a.publicKey, c.publicKey]),
    ).rejects.toMatchObject({ code: "rollback" });
    await trust.acceptGenerationSet("ws_1", 3, [a.publicKey]);
  });
});

describe("connecting an agent", () => {
  it("re-signs the current generation with the new key and wraps it for the token", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    const cli = createAgentKeyPair();
    const tokenId = newId("tok");
    const fields = await prepareConnectGeneration(api, {
      ...flow,
      tokenId,
      agentPublicKey: cli.publicKey,
    });
    expect(fields.keyGeneration).toBe(1);
    const generationEnvelope = {
      type: "key_generation" as const,
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      generation: 1,
      createdAt: fields.generationSignedAt,
    };
    const set = [world.account.encryption.publicKey, world.agent.publicKey];
    const signedGeneration = signKeyGeneration(
      { ...generationEnvelope, key: world.key, recipients: [...set, cli.publicKey] },
      world.account.signing,
    );
    expect(signedGeneration.signature).toBe(fields.generationSignature);
    expect(
      verifyKeyGeneration(signedGeneration, {
        ownerSigningPublicKey: world.account.signing.publicKey,
        workspaceId: world.workspaceId,
        generation: 1,
        recipients: [...set, cli.publicKey],
      }),
    ).toBe(true);
    const wrapped = fromBase64Url(fields.encWorkspaceKey);
    const signed = signEnvelope(
      {
        type: "wrapped_key",
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        recipient: fields.publicKey,
        holder: tokenId,
        generation: 1,
        ciphertextSha256: ciphertextSha256(wrapped),
        createdAt: fields.signedAt,
      },
      world.account.signing,
    );
    // the owner's signature over exactly that envelope, holder included
    expect(signed.signature).toBe(fields.signature);
    const key = unwrapSignedWorkspaceKey({ wrapped, signed, signedGeneration }, cli, {
      ownerSigningPublicKey: world.account.signing.publicKey,
      workspaceId: world.workspaceId,
      holder: tokenId,
    });
    expect(key).toEqual(world.key);
  });

  it("refuses a key or token that already holds a copy, and a key revoked from this device", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    const existingKey = await prepareConnectGeneration(api, {
      ...flow,
      tokenId: newId("tok"),
      agentPublicKey: world.agent.publicKey,
    }).catch((error: unknown) => error);
    expect(existingKey).toBeInstanceOf(RequestValidationError);
    const existingToken = await prepareConnectGeneration(api, {
      ...flow,
      tokenId: world.tokenId,
      agentPublicKey: createAgentKeyPair().publicKey,
    }).catch((error: unknown) => error);
    expect(existingToken).toBeInstanceOf(RequestValidationError);
    const revoked = createAgentKeyPair();
    await flow.trust.rememberRevocation(world.workspaceId, {
      tokenId: newId("tok"),
      publicKey: revoked.publicKey,
    });
    const again = await prepareConnectGeneration(api, {
      ...flow,
      tokenId: newId("tok"),
      agentPublicKey: revoked.publicKey,
    }).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(RequestValidationError);
  });
});

/** The last `rotateWorkspaceKey` request the server received (its body kept, whatever it answered). */
function lastRotation(world: World) {
  const kept = world.server.requests.filter(({ url }) => url.endsWith("/key-generations")).at(-1);
  if (kept === undefined) throw new Error("expected a rotation request");
  return kept;
}

/**
 * A server applying a rotation body it kept (after answering it with an error) in place of the
 * generation it stored since: the later generation's copies go, the kept ones come in.
 */
function applyKept(world: World, kept: ReturnType<typeof lastRotation>) {
  const server = world.server;
  const generation = server.keyGeneration;
  server.keyGeneration = generation - 1;
  server.sessionKeys = server.sessionKeys.filter((record) => record.keyGeneration < generation);
  server.agentKeys = server.agentKeys.filter((record) => record.keyGeneration < generation);
  const revoked = server.tokenRevoked;
  server.tokenRevoked = false; // a lying server wraps for whoever it likes
  void server.fetch(kept.url, kept.init);
  server.tokenRevoked = revoked;
}

describe("two owner-signed key sets for one generation", () => {
  it("refuses a kept rotation body served in place of the rotation that revoked the agent", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    // a rotation with the agent still in: the server keeps the body but answers 503
    world.server.tamper.refuse = (route) =>
      route === "rotateWorkspaceKey" ? "unavailable" : undefined;
    await expect(rotateWorkspace(api, flow)).rejects.toThrow();
    const kept = lastRotation(world);
    delete world.server.tamper.refuse;
    // then the owner revokes the agent and rotates to generation 2 without it
    expect((await revokeAndRotate(api, { ...flow, tokenId: world.tokenId })).generation).toBe(2);
    // the server swaps in the kept generation 2, which the revoked agent holds
    applyKept(world, kept);
    expect(world.server.agentKeys.some((record) => record.keyGeneration === 2)).toBe(true);
    const refused = await flow.keys.refresh().catch((error: unknown) => error);
    expect(isVaultError(refused, "pin_mismatch")).toBe(true);
  });

  it("catches a server that answers the rotation but serves a kept body instead", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    world.server.tamper.refuse = (route) =>
      route === "rotateWorkspaceKey" ? "unavailable" : undefined;
    await expect(rotateWorkspace(api, flow)).rejects.toThrow();
    const kept = lastRotation(world);
    delete world.server.tamper.refuse;
    world.server.tamper.hold = (route) => {
      if (route !== "rotateWorkspaceKey") return undefined;
      delete world.server.tamper.hold;
      applyKept(world, kept);
      return Promise.resolve();
    };
    const refused = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId }).catch(
      (error: unknown) => error,
    );
    expect(
      isVaultError(refused, "pin_mismatch") || isVaultError(refused, "untrusted_signature"),
    ).toBe(true);
    // the revocation stays pending, so the next rotation from this device leaves the agent out
    expect(await flow.trust.revocations(world.workspaceId)).toMatchObject([{ pending: true }]);
  });

  it("refuses two different keys for one generation in a keyring", async () => {
    const world = new World();
    const owner = {
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      signing: world.account.signing,
      holder: "account",
    };
    const account = { kind: "account" as const, accountId: world.accountId };
    const [first, second] = [createWorkspaceKey(), createWorkspaceKey()];
    const records = [first, second].map((key) =>
      wrappedRecord(
        world.workspaceId,
        account,
        wrapAndSignWorkspaceKey(key, world.account.encryption.publicKey, owner),
        1,
      ),
    );
    const options = {
      workspaceId: world.workspaceId,
      recipient: world.account.encryption,
      ownerSigningPublicKey: world.account.signing.publicKey,
      trust: new TrustState(new MemoryTrustStorage()),
    };
    const refused = await openWorkspaceKeyring(records, options).catch((error: unknown) => error);
    expect(isVaultError(refused, "untrusted_signature")).toBe(true);
    // one at a time: the first pins the generation's key, the second is refused
    await openWorkspaceKeyring(records.slice(0, 1), options);
    const later = await openWorkspaceKeyring(records.slice(1), options).catch(
      (error: unknown) => error,
    );
    expect(isVaultError(later, "pin_mismatch")).toBe(true);
  });

  it("refuses a generation set that grows by a revoked key", async () => {
    const trust = new TrustState(new MemoryTrustStorage());
    const [a, b, c, d] = [1, 2, 3, 4].map(() => createAgentKeyPair().publicKey) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    await trust.acceptGenerationSet("ws_1", 2, [a, b]);
    await trust.rememberRevocation("ws_1", { tokenId: "tok_1", publicKey: c });
    await expect(trust.acceptGenerationSet("ws_1", 2, [a, b, c])).rejects.toMatchObject({
      code: "rollback",
    });
    await expect(trust.acceptGenerationSet("ws_1", 2, [a, b, d], [d])).rejects.toMatchObject({
      code: "rollback",
    });
    // a key revoked while already in the set stays until the next generation
    await trust.acceptGenerationSet("ws_1", 2, [a, b], [b]);
    await trust.acceptGenerationSet("ws_1", 2, [a, b, d]);
  });
});

describe("revoking when the revoke itself failed", () => {
  it("sends the signed revoke on the next run, even after a rotation left the agent out", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    world.server.tamper.refuse = (route) => (route === "revokeToken" ? "unavailable" : undefined);
    await expect(revokeAndRotate(api, { ...flow, tokenId: world.tokenId })).rejects.toThrow();
    expect(world.server.tokenRevoked).toBe(false);
    delete world.server.tamper.refuse;
    // a rotation in between (remembered revocations are left out of it)
    const rotated = await rotateWorkspace(api, flow);
    expect(rotated.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
    // no signed record is listed yet: the next run sends it, without another rotation
    const result = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId });
    expect(result.generation).toBe(2);
    expect(world.server.tokenRevoked).toBe(true);
    expect(world.server.revocations).toHaveLength(1);
    expect(world.server.rotations).toBe(1);
  });

  it("counts a revocation only for the token's own key", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    // an owner-signed record for the token, but over another key, doesn't make it revoked
    const other = signRevocation(world.signer, {
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      recipientPublicKey: createAgentKeyPair().publicKey,
    });
    const listing = rewriteListKeys(api, (data) => ({
      ...data,
      revocations: [
        ...(data.revocations ?? []),
        {
          workspaceId: world.workspaceId,
          tokenId: world.tokenId,
          signed: other.signed as never,
        },
      ],
    }));
    await revokeAndRotate(listing, { ...flow, tokenId: world.tokenId });
    expect(world.server.revocations).toHaveLength(1);
    expect(world.server.tokenRevoked).toBe(true);
  });
});

describe("connecting without the owner's copy", () => {
  it("refuses to re-sign a generation set that lacks the owner's own key", async () => {
    const world = new World();
    const { api, flow } = ownerFlow(world);
    // an owner-signed set of generation 1 with only the agent in it, the account copy left out
    const agentOnly = signKeyGeneration(
      {
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        key: world.key,
        recipients: [world.agent.publicKey],
      },
      world.account.signing,
    );
    const listing = rewriteListKeys(api, (data) => ({
      ...data,
      recipients: (data.recipients ?? [])
        .filter((record) => record.recipient.kind === "token")
        .map((record) => ({
          ...record,
          signedGeneration: {
            envelope: agentOnly.envelope,
            signature: agentOnly.signature,
          } as RecipientKey["signedGeneration"],
        })),
    }));
    const refused = await prepareConnectGeneration(listing, {
      ...flow,
      tokenId: newId("tok"),
      agentPublicKey: createAgentKeyPair().publicKey,
    }).catch((error: unknown) => error);
    expect(isVaultError(refused, "missing_key")).toBe(true);
  });
});

/** A person's save of a new note from a browser with `trust`, or the error it fails with. */
async function save(world: World, trust: TrustState): Promise<unknown> {
  return world
    .web({ trust })
    .engine.writeNote({
      noteId: newId("note"),
      folderId: world.folderId,
      baseVersion: 0,
      name: "new.md",
      text: "new data",
    })
    .then((result) => result.status)
    .catch((error: unknown) => error);
}

/** A server that drops the newest generation and serves the one before it again. */
function dropNewest(world: World) {
  const server = world.server;
  const generation = server.keyGeneration;
  server.keyGeneration = generation - 1;
  server.sessionKeys = server.sessionKeys.filter((record) => record.keyGeneration < generation);
  server.agentKeys = server.agentKeys.filter((record) => record.keyGeneration < generation);
}

describe("writing while a rotation is pending", () => {
  it("refuses to write after a rotation the server answered but then withheld", async () => {
    const world = new World();
    const trust = new TrustState(new MemoryTrustStorage());
    const { api, flow } = ownerFlow(world, trust);
    world.server.tamper.hold = (route) => {
      if (route !== "rotateWorkspaceKey") return undefined;
      delete world.server.tamper.hold;
      dropNewest(world); // 200, then only generation 1 again
      return Promise.resolve();
    };
    const refused = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId }).catch(
      (error: unknown) => error,
    );
    expect(isVaultError(refused, "rollback")).toBe(true);
    expect(await trust.keyGeneration(world.workspaceId)).toBe(2);
    // this device won't go back to generation 1, the revoked agent's
    expect(isVaultError(await save(world, trust), "rollback")).toBe(true);
    // a fresh device sees the signed revocation and holds back too
    const fresh = new TrustState(new MemoryTrustStorage());
    expect(isVaultError(await save(world, fresh), "rotation_pending")).toBe(true);
  });

  it("refuses to write while every rotation fails, and writes again once one succeeds", async () => {
    const world = new World();
    const trust = new TrustState(new MemoryTrustStorage());
    const { api, flow } = ownerFlow(world, trust);
    world.server.tamper.refuse = (route) =>
      route === "rotateWorkspaceKey" ? "unavailable" : undefined;
    await expect(revokeAndRotate(api, { ...flow, tokenId: world.tokenId })).rejects.toThrow();
    await expect(rotateWorkspace(api, flow)).rejects.toThrow();
    const stuck = await save(world, trust);
    expect(isVaultError(stuck, "rotation_pending")).toBe(true);
    expect((stuck as Error).message).toMatch(/rotation pending/);
    expect(
      isVaultError(await save(world, new TrustState(new MemoryTrustStorage())), "rotation_pending"),
    ).toBe(true);
    delete world.server.tamper.refuse;
    await rotateWorkspace(api, flow);
    expect(await save(world, trust)).toBe("saved");
  });

  it("refuses a newer generation another owner device made with the revoked agent in it", async () => {
    const world = new World();
    const trust = new TrustState(new MemoryTrustStorage());
    const { api, flow } = ownerFlow(world, trust);
    // this device revokes; its rotation fails
    world.server.tamper.refuse = (route) =>
      route === "rotateWorkspaceKey" ? "unavailable" : undefined;
    await expect(revokeAndRotate(api, { ...flow, tokenId: world.tokenId })).rejects.toThrow();
    delete world.server.tamper.refuse;
    // another owner device that never saw the revocation (the server hides it) rotates first,
    // keeping the agent in generation 2
    const hiding = rewriteListKeys(world.web().api, (data) => ({
      ...data,
      recipients: (data.recipients ?? []).map((record) => ({ ...record, revokedAt: null })),
      revocations: [],
    }));
    const otherTrust = new TrustState(new MemoryTrustStorage());
    const otherFlow = {
      ...flow,
      trust: otherTrust,
      keys: createKeyProvider(hiding, {
        workspaceId: world.workspaceId,
        recipient: world.account.encryption,
        ownerSigningPublicKey: world.account.signing.publicKey,
        ownerAccountId: world.accountId,
        trust: otherTrust,
      }),
    };
    world.server.tokenRevoked = false; // the server lets it wrap for the revoked token
    const forked = await rotateWorkspace(hiding, otherFlow);
    world.server.tokenRevoked = true;
    expect(forked.recipients.map((entry) => entry.recipient.kind).sort()).toEqual([
      "account",
      "token",
    ]);
    // this device remembers the revocation: generation 2 still holds the agent, so it holds back
    expect(isVaultError(await save(world, trust), "rotation_pending")).toBe(true);
    // and its next rotation leaves the agent out
    const fixed = await rotateWorkspace(api, flow);
    expect(fixed.generation).toBe(3);
    expect(fixed.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
    expect(await save(world, trust)).toBe("saved");
  });
});

/**
 * The world's generation 1 as it was before its agent connected: the account's copy only,
 * re-signed over the account's key alone. A device that refreshed then saw that set.
 */
function beforeTheAgent(world: World, api: ApiClient): ApiClient {
  const accountOnly = signKeyGeneration(
    {
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      key: world.key,
      recipients: [world.account.encryption.publicKey],
    },
    world.account.signing,
  );
  return rewriteListKeys(api, (data) => ({
    ...data,
    recipients: (data.recipients ?? [])
      .filter((record) => record.recipient.kind === "account")
      .map((record) => ({
        ...record,
        signedGeneration: {
          envelope: accountOnly.envelope,
          signature: accountOnly.signature,
        } as RecipientKey["signedGeneration"],
      })),
    revocations: [],
  }));
}

function keysOver(world: World, api: ApiClient, trust: TrustState) {
  return createKeyProvider(api, {
    workspaceId: world.workspaceId,
    recipient: world.account.encryption,
    ownerSigningPublicKey: world.account.signing.publicKey,
    ownerAccountId: world.accountId,
    trust,
  });
}

describe("revoking an agent this device just approved", () => {
  /**
   * This device approves the world's agent (it saw generation 1 without it), the approval lands,
   * and the device remembers revoking it before it saw the grown set: a connect it couldn't
   * deliver to the CLI.
   */
  async function approvedThenRemembered(world: World) {
    const trust = new TrustState(new MemoryTrustStorage());
    const { api, flow } = ownerFlow(world, trust);
    const before = beforeTheAgent(world, api);
    await prepareConnectGeneration(before, {
      ...flow,
      keys: keysOver(world, before, trust),
      tokenId: world.tokenId,
      agentPublicKey: world.agent.publicKey,
    });
    await trust.rememberRevocation(world.workspaceId, {
      tokenId: world.tokenId,
      publicKey: world.agent.publicKey,
    });
    return { api, flow: { ...flow, keys: keysOver(world, api, trust) }, trust };
  }

  it("revokes and rotates it out", async () => {
    const world = new World();
    const { api, flow } = await approvedThenRemembered(world);
    const result = await revokeAndRotate(api, { ...flow, tokenId: world.tokenId });
    expect(result.generation).toBe(2);
    expect(result.recipients.map((entry) => entry.recipient.kind)).toEqual(["account"]);
    expect(world.server.tokenRevoked).toBe(true);
    expect(world.server.revocations).toHaveLength(1);
  });

  it("refreshes the keys meanwhile, with a rotation pending", async () => {
    const world = new World();
    const { flow, trust } = await approvedThenRemembered(world);
    expect((await flow.keys.refresh()).current.generation).toBe(1);
    expect(isVaultError(await save(world, trust), "rotation_pending")).toBe(true);
  });

  it("still refuses a set grown by a key revoked here that this device never approved", async () => {
    const world = new World();
    const trust = new TrustState(new MemoryTrustStorage());
    const { api } = ownerFlow(world, trust);
    // this device saw generation 1 without the agent, then the agent's signed revocation
    await keysOver(world, beforeTheAgent(world, api), trust).refresh();
    await trust.rememberRevocation(world.workspaceId, {
      tokenId: world.tokenId,
      publicKey: world.agent.publicKey,
    });
    const refused = await keysOver(world, api, trust)
      .refresh()
      .catch((error: unknown) => error);
    expect(isVaultError(refused, "rollback")).toBe(true);
  });

  it("only lets the approved key into the generation it was approved into", async () => {
    const marks = new TrustState(new MemoryTrustStorage());
    const [a, b, c] = [1, 2, 3].map(() => createAgentKeyPair().publicKey) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    await marks.acceptGenerationSet("ws_1", 2, [a]);
    await marks.rememberApproval("ws_1", 1, b);
    await marks.rememberApproval("ws_1", 2, c);
    // signed-revoked keys: b was approved into another generation, c into this one
    await expect(marks.acceptGenerationSet("ws_1", 2, [a, b], [b])).rejects.toMatchObject({
      code: "rollback",
    });
    await marks.acceptGenerationSet("ws_1", 2, [a, c], [c]);
    // a new generation forgets the old approvals
    await marks.acceptGenerationSet("ws_1", 3, [a]);
    await expect(marks.acceptGenerationSet("ws_1", 3, [a, c], [c])).rejects.toMatchObject({
      code: "rollback",
    });
  });
});
