import { beforeAll, describe, expect, it } from "vitest";

import {
  createAccountKeys,
  createAgentSigningKeyPair,
  ready,
  toBase64Url,
} from "../../crypto/index.js";
import type {
  AgentKeyRecord,
  SignedAgentKey,
  SignedEvent,
  TokenRevocation,
} from "../../protocol/index.js";
import { agentPolicyFolderHash, routes } from "../../protocol/index.js";
import { isSyncApiError, isVaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { type Client, World } from "../testing/world.js";
import {
  encryptAgentName,
  MemoryTrustStorage,
  prepareAgentKeyApproval,
  prepareFolder,
  signAgentEdited,
  signAgentKey,
  signRevocation,
  TrustState,
  verifiedAgentKeys,
  verifyAgentEdited,
} from "./index.js";

beforeAll(ready);

/**
 * An owner's `approveConnect` with these agent-key fields; the rest of the strict request is
 * well-formed filler (the fake server checks only the agent key).
 */
async function approve(
  world: World,
  web: Client,
  fields: { signPublicKey: string; agentKeySignedAt: string; agentKeySignature: string },
) {
  const bytes = (length: number, fill: number) => toBase64Url(new Uint8Array(length).fill(fill));
  return web.api.call(routes.approveConnect, {
    params: { requestId: newId("cr") },
    body: {
      tokenId: world.tokenId,
      tokenSecretSha256: bytes(32, 1),
      workspaceId: world.workspaceId,
      access: "read-write",
      folderIds: [],
      encName: encryptAgentName(
        world.key,
        { workspaceId: world.workspaceId, tokenId: world.tokenId },
        "Claude",
      ),
      publicKey: toBase64Url(world.agent.publicKey),
      keyGeneration: 1,
      encWorkspaceKey: bytes(80, 2),
      signedAt: new Date().toISOString(),
      signature: bytes(64, 3),
      keyCommitment: "c".repeat(64),
      generationSignedAt: new Date().toISOString(),
      generationSignature: bytes(64, 4),
      ...fields,
    },
  });
}

/** An owner, an agent with a vouched key, and a write it signed. */
function setup(options: { signedAt?: string } = {}) {
  const owner = createAccountKeys();
  const accountId = newId("acc");
  const workspaceId = newId("ws");
  const tokenId = newId("tok");
  const agentKey = createAgentSigningKeyPair();
  const signer = { accountId, signing: owner.signing };
  const vouched = signAgentKey(signer, {
    workspaceId,
    tokenId,
    signPublicKey: agentKey.publicKey,
    policyRevision: 2,
  }).signed as unknown as SignedAgentKey;
  const ciphertext = new Uint8Array([1, 2, 3]);
  const write = signAgentEdited(
    { tokenId, ownerAccountId: accountId, signing: agentKey },
    {
      workspaceId,
      noteId: newId("note"),
      folderId: newId("fld"),
      baseVersion: 4,
      ciphertext,
      revision: 2,
      policySha256: "a".repeat(64),
      ...(options.signedAt === undefined ? {} : { signedAt: options.signedAt }),
    },
  ).signed as unknown as SignedEvent;
  return { owner, accountId, workspaceId, tokenId, agentKey, signer, vouched, write };
}

describe("verifyAgentEdited", () => {
  it("accepts an agent's write under the key the owner vouched for", () => {
    const { owner, accountId, vouched, write, tokenId } = setup();
    const ownerKey = { publicKey: owner.signing.publicKey, accountId };
    expect(verifyAgentEdited(write, vouched, ownerKey, { expected: { version: 5 } })).toEqual({
      ok: true,
      tokenId,
      revoked: false,
    });
    // a field the caller knows independently must match
    expect(verifyAgentEdited(write, vouched, ownerKey, { expected: { version: 4 } })).toEqual({
      ok: false,
      problem: "bad_signature",
    });
  });

  it("refuses a key vouched by anyone but the owner, or for another token", () => {
    const { owner, accountId, workspaceId, agentKey, vouched, write } = setup();
    const ownerKey = { publicKey: owner.signing.publicKey, accountId };
    const stranger = { publicKey: createAccountKeys().signing.publicKey, accountId };
    expect(verifyAgentEdited(write, vouched, stranger)).toEqual({
      ok: false,
      problem: "unvouched_key",
    });
    const forOther = signAgentKey(
      { accountId, signing: owner.signing },
      { workspaceId, tokenId: newId("tok"), signPublicKey: agentKey.publicKey, policyRevision: 0 },
    ).signed as unknown as SignedAgentKey;
    expect(verifyAgentEdited(write, forOther, ownerKey)).toEqual({
      ok: false,
      problem: "mismatch",
    });
    // a vouched key, but the write was signed by another one
    const otherKey = signAgentKey(
      { accountId, signing: owner.signing },
      {
        workspaceId,
        tokenId: write.envelope.type === "agent_edited" ? write.envelope.tokenId : newId("tok"),
        signPublicKey: createAgentSigningKeyPair().publicKey,
        policyRevision: 0,
      },
    ).signed as unknown as SignedAgentKey;
    expect(verifyAgentEdited(write, otherKey, ownerKey)).toEqual({
      ok: false,
      problem: "bad_signature",
    });
  });

  it("flags a revoked agent's earlier write and refuses one signed after the revocation", () => {
    const { owner, accountId, workspaceId, tokenId, signer, vouched, write } = setup({
      signedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const ownerKey = { publicKey: owner.signing.publicKey, accountId };
    const revoke = (signedAt: string) =>
      signRevocation(signer, {
        workspaceId,
        tokenId,
        recipientPublicKey: new Uint8Array(32).fill(7),
        signedAt,
      }).signed as unknown as SignedEvent;
    const later = revoke(new Date().toISOString());
    expect(verifyAgentEdited(write, vouched, ownerKey, { revocation: later })).toEqual({
      ok: true,
      tokenId,
      revoked: true,
    });
    const earlier = revoke(new Date(Date.now() - 120_000).toISOString());
    expect(verifyAgentEdited(write, vouched, ownerKey, { revocation: earlier })).toEqual({
      ok: false,
      problem: "after_revocation",
    });
    // the server's word alone flags, never refuses
    expect(
      verifyAgentEdited(write, vouched, ownerKey, { revokedAt: new Date().toISOString() }),
    ).toEqual({ ok: true, tokenId, revoked: true });
    // a revocation the owner didn't sign is ignored
    const forged = signRevocation(
      { accountId, signing: createAccountKeys().signing },
      {
        workspaceId,
        tokenId,
        recipientPublicKey: new Uint8Array(32).fill(7),
        signedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    ).signed as unknown as SignedEvent;
    expect(verifyAgentEdited(write, vouched, ownerKey, { revocation: forged })).toMatchObject({
      ok: true,
      revoked: false,
    });
  });

  it("reads only this workspace's records, each once", () => {
    const { owner, accountId, workspaceId, tokenId, agentKey, vouched } = setup();
    const ownerKey = { publicKey: owner.signing.publicKey, accountId };
    const elsewhere = signAgentKey(
      { accountId, signing: owner.signing },
      {
        workspaceId: newId("ws"),
        tokenId,
        signPublicKey: agentKey.publicKey,
        policyRevision: 0,
      },
    ).signed as unknown as SignedAgentKey;
    const keys = verifiedAgentKeys(
      {
        agentKeys: [
          { signed: vouched, revokedAt: null },
          { signed: vouched, revokedAt: null },
          { signed: elsewhere, revokedAt: null },
        ],
      },
      ownerKey,
      workspaceId,
    );
    expect(keys.get(tokenId)).toHaveLength(1);
  });

  it("reads listKeys: only owner-signed keys, with the earliest signed revocation", () => {
    const { owner, accountId, workspaceId, tokenId, signer, vouched } = setup();
    const ownerKey = { publicKey: owner.signing.publicKey, accountId };
    const forged = signAgentKey(
      { accountId, signing: createAccountKeys().signing },
      {
        workspaceId,
        tokenId: newId("tok"),
        signPublicKey: createAgentSigningKeyPair().publicKey,
        policyRevision: 0,
      },
    ).signed as unknown as SignedAgentKey;
    const revocation = (signedAt: string): TokenRevocation => ({
      workspaceId,
      tokenId,
      signed: signRevocation(signer, {
        workspaceId,
        tokenId,
        recipientPublicKey: new Uint8Array(32).fill(7),
        signedAt,
      }).signed as unknown as SignedEvent,
    });
    const first = new Date(Date.now() - 60_000).toISOString();
    const records: AgentKeyRecord[] = [
      { signed: vouched, revokedAt: null },
      { signed: forged, revokedAt: null },
    ];
    const keys = verifiedAgentKeys(
      {
        agentKeys: records,
        revocations: [revocation(new Date().toISOString()), revocation(first)],
      },
      ownerKey,
      workspaceId,
    );
    expect([...keys.keys()]).toEqual([tokenId]);
    expect(keys.get(tokenId)).toMatchObject([
      { policyRevision: 2, revoked: true, revokedSignedAt: first },
    ]);
  });
});

describe("prepareAgentKeyApproval", () => {
  it("checks the current policy, then vouches for the key with its revision as the floor", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 0 });
    const trust = new TrustState(new MemoryTrustStorage());
    const key = createAgentSigningKeyPair();
    const prepared = await prepareAgentKeyApproval(web.api, {
      signer: world.signer,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: key.publicKey,
      trust,
    });
    expect(prepared).toMatchObject({
      fields: { signPublicKey: toBase64Url(key.publicKey) },
      policyRevision: 1,
    });
    expect(Object.keys(prepared.fields).sort()).toEqual([
      "agentKeySignature",
      "agentKeySignedAt",
      "signPublicKey",
    ]);
    expect(await trust.agentPolicyRevision(world.workspaceId)).toBe(1);
    // the fields spread into the strict request; the server rebuilds agent_key with its revision
    await approve(world, web, prepared.fields);
    expect(world.server.agentKeyRecords.at(-1)?.signed.envelope).toMatchObject({
      type: "agent_key",
      tokenId: world.tokenId,
      policyRevision: 1,
    });
    // the policy moved in between: 409 stale_agent_policy, so prepare again and approve again
    const stale = await prepareAgentKeyApproval(web.api, {
      signer: world.signer,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: toBase64Url(key.publicKey),
    });
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 1 });
    const refused = await approve(world, web, stale.fields).catch((error: unknown) => error);
    expect(isSyncApiError(refused, "stale_agent_policy")).toBe(true);
    const again = await prepareAgentKeyApproval(web.api, {
      signer: world.signer,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: key.publicKey,
    });
    await approve(world, web, again.fields);
    expect(world.server.agentKeyRecords.at(-1)?.signed.envelope).toMatchObject({
      policyRevision: 2,
    });
    // any other mismatch is a bad signature
    const forged = await approve(world, web, {
      ...again.fields,
      signPublicKey: toBase64Url(createAgentSigningKeyPair().publicKey),
    }).catch((error: unknown) => error);
    expect(isSyncApiError(forged, "invalid_signature")).toBe(true);
  });

  it("refuses to vouch over a policy that doesn't verify or went back", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    const details = {
      signer: world.signer,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: createAgentSigningKeyPair().publicKey,
    };
    world.server.tamper.agentPolicy = (policy) => ({ ...policy, default: "direct" });
    await expect(prepareAgentKeyApproval(web.api, details)).rejects.toSatisfy((error: unknown) =>
      isVaultError(error, "untrusted_signature"),
    );
    delete world.server.tamper.agentPolicy;
    const trust = new TrustState(new MemoryTrustStorage());
    await trust.acceptAgentPolicyRevision(world.workspaceId, 5);
    await expect(prepareAgentKeyApproval(web.api, { ...details, trust })).rejects.toSatisfy(
      (error: unknown) => isVaultError(error, "rollback"),
    );
  });

  it("refuses to vouch over an agent's view instead of the full policy", async () => {
    const world = new World();
    const web = world.web();
    const folder = prepareFolder(world.signer, world.key, {
      workspaceId: world.workspaceId,
      parentId: null,
      name: "Ask first",
      rootFolderId: null,
    });
    await web.api.call(routes.createFolder, {
      params: { workspaceId: world.workspaceId },
      body: folder,
    });
    const folderId = folder.id;
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId, mode: "review" }],
      baseRevision: 0,
    });
    const details = {
      signer: world.signer,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: createAgentSigningKeyPair().publicKey,
    };
    // the override moved among the hashes: the owner's signature still covers it
    const hidden = await agentPolicyFolderHash({ folderId, mode: "review" });
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      folders: [],
      otherFolderHashes: [hidden],
      ancestors: [],
    });
    await expect(prepareAgentKeyApproval(web.api, details)).rejects.toSatisfy((error: unknown) =>
      isVaultError(error, "untrusted_signature"),
    );
    // ancestors never belong in a person's read
    world.server.tamper.agentPolicy = (policy) => ({
      ...policy,
      ancestors: [{ folderId, ancestorIds: [] }],
    });
    await expect(prepareAgentKeyApproval(web.api, details)).rejects.toSatisfy((error: unknown) =>
      isVaultError(error, "untrusted_signature"),
    );
    delete world.server.tamper.agentPolicy;
    expect(await prepareAgentKeyApproval(web.api, details)).toMatchObject({ policyRevision: 1 });
  });

  it("refuses to vouch over a second owner-signed policy at a revision it verified", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    const details = {
      signer: world.signer,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: createAgentSigningKeyPair().publicKey,
      trust: new TrustState(new MemoryTrustStorage()),
    };
    expect(await prepareAgentKeyApproval(web.api, details)).toMatchObject({ policyRevision: 1 });
    // the server shows another device revision 0, and the owner signs a second revision 1
    const real = world.server.agentPolicies.splice(0);
    await world.web().engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 0 });
    await expect(prepareAgentKeyApproval(web.api, details)).rejects.toSatisfy((error: unknown) =>
      isVaultError(error, "untrusted_signature"),
    );
    // the revision this device verified, same hash: fine
    world.server.agentPolicies.splice(0, world.server.agentPolicies.length, ...real);
    expect(await prepareAgentKeyApproval(web.api, details)).toMatchObject({ policyRevision: 1 });
  });

  it("never vouches below a revision the owner signed into an agent key", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    const old = world.server.agentPolicy;
    await web.engine.setAgentPolicy({ default: "direct", folders: [], baseRevision: 1 });
    // another device approved an agent at revision 2, since revoked; this device saw nothing
    const vouched = signAgentKey(world.signer, {
      workspaceId: world.workspaceId,
      tokenId: newId("tok"),
      signPublicKey: createAgentSigningKeyPair().publicKey,
      policyRevision: 2,
    }).signed as unknown as SignedAgentKey;
    world.server.agentKeyRecords.push({ signed: vouched, revokedAt: new Date().toISOString() });
    // a forged record with a higher revision doesn't count
    const forged = signAgentKey(
      { accountId: world.accountId, signing: createAccountKeys().signing },
      {
        workspaceId: world.workspaceId,
        tokenId: newId("tok"),
        signPublicKey: createAgentSigningKeyPair().publicKey,
        policyRevision: 9,
      },
    ).signed as unknown as SignedAgentKey;
    world.server.agentKeyRecords.push({ signed: forged, revokedAt: null });
    const details = {
      signer: world.signer,
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      signPublicKey: createAgentSigningKeyPair().publicKey,
      trust: new TrustState(new MemoryTrustStorage()),
    };
    expect(await prepareAgentKeyApproval(web.api, details)).toMatchObject({ policyRevision: 2 });
    // the server replays revision 1 to a fresh device
    world.server.tamper.agentPolicy = () => old;
    await expect(
      prepareAgentKeyApproval(web.api, {
        ...details,
        trust: new TrustState(new MemoryTrustStorage()),
      }),
    ).rejects.toSatisfy((error: unknown) => isVaultError(error, "rollback"));
  });
});
