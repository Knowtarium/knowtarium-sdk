import { beforeAll, describe, expect, it } from "vitest";

import {
  canonicalizeEnvelope,
  ciphertextSha256,
  createAccountKeys,
  fromBase64Url,
  ready,
  recipientsHash,
  type SignedEnvelope,
  type SignedEnvelopeFields,
  toBase64Url,
  unwrapSignedWorkspaceKey,
  verifyEnvelope,
  verifyEnvelopeFor,
} from "../../crypto/index.js";
import {
  SignedEnvelope as ProtocolEnvelope,
  envelopeSigningText,
  ENVELOPE_SIGNING_PREFIX,
} from "../../protocol/index.js";
import { RequestValidationError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { decryptFolderName, decryptWorkspaceName } from "./content.js";
import {
  type SignedAction,
  signApproved,
  signCommented,
  signDeleted,
  signEdited,
  signFolderCreated,
  signFolderMoved,
  signGeneration,
  signingFields,
  signingHeaders,
  signRecorded,
  signRejected,
  signRevocation,
} from "./envelopes.js";
import type { Signer } from "./signer.js";
import { prepareFolder, prepareWorkspace } from "./workspace.js";

beforeAll(ready);

const at = Date.parse("2026-10-01T09:30:00.123Z");

function setup() {
  const keys = createAccountKeys();
  const signer: Signer = { accountId: newId("acc"), signing: keys.signing, now: () => at };
  return { keys, signer, workspaceId: newId("ws") };
}

/** The envelope passes crypto's verification, the protocol's schema, and both canonical forms agree. */
function expectServerVerifiable(signed: SignedEnvelope, publicKey: Uint8Array): void {
  expect(verifyEnvelope(signed, publicKey)).toBe(true);
  const parsed = ProtocolEnvelope.parse(signed.envelope);
  expect(envelopeSigningText(parsed)).toBe(
    ENVELOPE_SIGNING_PREFIX + canonicalizeEnvelope(signed.envelope),
  );
}

describe("signed envelope builders", () => {
  const ciphertext = new Uint8Array(80).fill(9);
  let hash = "";
  beforeAll(() => {
    hash = ciphertextSha256(ciphertext);
  });

  it("signs edited at the base version + 1 over the ciphertext", () => {
    const { keys, signer, workspaceId } = setup();
    const noteId = newId("note");
    const folderId = newId("fld");
    const action = signEdited(signer, {
      workspaceId,
      noteId,
      folderId,
      baseVersion: 3,
      ciphertext,
    });
    expectServerVerifiable(action.signed, keys.signing.publicKey);
    expect(action.signed.envelope).toEqual({
      type: "edited",
      accountId: signer.accountId,
      workspaceId,
      noteId,
      folderId,
      version: 4,
      ciphertextSha256: hash,
      createdAt: "2026-10-01T09:30:00.123Z",
    });
    expect(signingHeaders(action)).toEqual({
      "knowtarium-signature": action.signature,
      "knowtarium-signed-at": "2026-10-01T09:30:00.123Z",
    });
  });

  it("builds every type the protocol table lists, each verifiable", () => {
    const { keys, signer, workspaceId } = setup();
    const noteId = newId("note");
    const pendingId = newId("pc");
    const commentId = newId("cmt");
    const folderId = newId("fld");
    const parentId = newId("fld");
    const cases: [
      SignedAction,
      Partial<SignedEnvelopeFields> & { type: SignedEnvelopeFields["type"] },
    ][] = [
      [
        signDeleted(signer, { workspaceId, noteId, baseVersion: 0 }),
        { type: "deleted", noteId, version: 1 },
      ],
      [
        signApproved(signer, {
          workspaceId,
          noteId,
          pendingId,
          folderId,
          baseVersion: 2,
          ciphertext,
        }),
        { type: "approved", noteId, pendingId, folderId, version: 3, ciphertextSha256: hash },
      ],
      [
        signRejected(signer, {
          workspaceId,
          noteId,
          pendingId,
          commentId,
          commentCiphertext: ciphertext,
        }),
        { type: "rejected", noteId, pendingId, commentId, ciphertextSha256: hash },
      ],
      [
        signCommented(signer, { workspaceId, noteId, commentId, baseRevision: null, ciphertext }),
        { type: "commented", noteId, commentId, revision: 1, ciphertextSha256: hash },
      ],
      [
        signCommented(signer, { workspaceId, noteId, commentId, baseRevision: 4, ciphertext }),
        { type: "commented", revision: 5 },
      ],
      [
        signRecorded(signer, { workspaceId, noteId, eventId: newId("evt"), ciphertext }),
        { type: "recorded", noteId, ciphertextSha256: hash },
      ],
      [
        signFolderCreated(signer, { workspaceId, folderId, parentId, encName: ciphertext }),
        { type: "folder_created", folderId, parentId, ciphertextSha256: hash },
      ],
      [
        signFolderMoved(signer, { workspaceId, folderId, parentId }),
        { type: "folder_moved", folderId, parentId },
      ],
    ];
    for (const [action, expected] of cases) {
      expectServerVerifiable(action.signed, keys.signing.publicKey);
      expect(
        verifyEnvelopeFor(action.signed, keys.signing.publicKey, {
          ...expected,
          accountId: signer.accountId,
          workspaceId,
        }),
      ).toBe(true);
      expect(signingFields(action)).toEqual({
        signedAt: action.signed.envelope.createdAt,
        signature: action.signature,
      });
    }
  });

  it("leaves parentId out at the root", () => {
    const { keys, signer, workspaceId } = setup();
    const folderId = newId("fld");
    const created = signFolderCreated(signer, {
      workspaceId,
      folderId,
      parentId: null,
      encName: ciphertext,
    });
    const moved = signFolderMoved(signer, { workspaceId, folderId, parentId: null });
    expect(created.signed.envelope).not.toHaveProperty("parentId");
    expect(moved.signed.envelope).not.toHaveProperty("parentId");
    expectServerVerifiable(created.signed, keys.signing.publicKey);
    expectServerVerifiable(moved.signed, keys.signing.publicKey);
  });

  it("signs a key generation", () => {
    const { keys, signer, workspaceId } = setup();
    const generation = signGeneration(signer, {
      workspaceId,
      key: { generation: 2, key: new Uint8Array(32).fill(7) },
      recipients: [keys.encryption.publicKey],
    });
    expectServerVerifiable(generation.signed, keys.signing.publicKey);
    expect(generation.generationSignedAt).toBe("2026-10-01T09:30:00.123Z");
    expect(generation.signed.envelope).toMatchObject({ type: "key_generation", generation: 2 });
  });

  it("never verifies with another key", () => {
    const { signer, workspaceId } = setup();
    const other = createAccountKeys();
    const action = signDeleted(signer, { workspaceId, noteId: newId("note"), baseVersion: 0 });
    expect(verifyEnvelope(action.signed, other.signing.publicKey)).toBe(false);
  });
});

describe("signing times", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("signs at a given time within the skew, so content can name the same time", () => {
    const { signer, workspaceId } = setup();
    const early = iso(at - 299_000);
    const late = iso(at + 299_000);
    const noteId = newId("note");
    const edited = signEdited(signer, {
      workspaceId,
      noteId,
      folderId: newId("fld"),
      baseVersion: 1,
      ciphertext: new Uint8Array([1]),
      signedAt: early,
    });
    expect(edited.signedAt).toBe(early);
    expect(edited.signed.envelope.createdAt).toBe(early);
    const approved = signApproved(signer, {
      workspaceId,
      noteId,
      pendingId: newId("pc"),
      folderId: newId("fld"),
      baseVersion: 1,
      ciphertext: new Uint8Array([1]),
      signedAt: late,
    });
    expect(approved.signed.envelope.createdAt).toBe(late);
    const deleted = signDeleted(signer, { workspaceId, noteId, baseVersion: 2, signedAt: late });
    expect(deleted.signedAt).toBe(late);
    const generation = signGeneration(signer, {
      workspaceId,
      key: { generation: 2, key: new Uint8Array(32).fill(7) },
      recipients: [new Uint8Array(32)],
      signedAt: early,
    });
    expect(generation.generationSignedAt).toBe(early);
    // without one, it's the signer's now
    expect(signDeleted(signer, { workspaceId, noteId, baseVersion: 2 }).signedAt).toBe(iso(at));
  });

  it.each([
    ["past the skew", iso(at - 301_000)],
    ["ahead of the skew", iso(at + 301_000)],
    ["without milliseconds", "2026-10-01T09:30:00Z"],
    ["with an offset", "2026-10-01T11:30:00.123+02:00"],
    ["not a time", "yesterday"],
  ])("refuses a signing time %s before signing", (_label, signedAt) => {
    const { signer, workspaceId } = setup();
    const noteId = newId("note");
    expect(() => signDeleted(signer, { workspaceId, noteId, baseVersion: 1, signedAt })).toThrow(
      RequestValidationError,
    );
    expect(() =>
      signRevocation(signer, {
        workspaceId,
        tokenId: newId("tok"),
        recipientPublicKey: new Uint8Array(32),
        signedAt,
      }),
    ).toThrow(RequestValidationError);
  });
});

describe("prepared requests", () => {
  it("prepares a workspace whose key the owner can unwrap after verifying", () => {
    const { keys, signer } = setup();
    const { request, key } = prepareWorkspace(signer, {
      name: "Clients",
      accountBoxPublicKey: keys.encryption.publicKey,
    });
    expect(decryptWorkspaceName(key, request.id, request.encName)).toBe("Clients");
    const toSigned = (envelope: SignedEnvelopeFields, signature: string): SignedEnvelope => ({
      version: 1,
      envelope,
      signature,
    });
    const unwrapped = unwrapSignedWorkspaceKey(
      {
        wrapped: fromBase64Url(request.encWorkspaceKey),
        signed: toSigned(
          {
            type: "wrapped_key",
            accountId: signer.accountId,
            workspaceId: request.id,
            recipient: toBase64Url(keys.encryption.publicKey),
            holder: "account",
            generation: 1,
            ciphertextSha256: ciphertextSha256(fromBase64Url(request.encWorkspaceKey)),
            createdAt: request.signedAt,
          },
          request.signature,
        ),
        signedGeneration: toSigned(
          {
            type: "key_generation",
            accountId: signer.accountId,
            workspaceId: request.id,
            generation: 1,
            recipientsHash: recipientsHash([keys.encryption.publicKey]),
            keyCommitment: request.keyCommitment,
            createdAt: request.generationSignedAt,
          },
          request.generationSignature,
        ),
      },
      keys.encryption,
      { ownerSigningPublicKey: keys.signing.publicKey, workspaceId: request.id },
    );
    expect(unwrapped.key).toEqual(key.key);
  });

  it("prepares a signed folder with an encrypted name", () => {
    const { keys, signer, workspaceId } = setup();
    const { key } = prepareWorkspace(signer, {
      name: "x",
      accountBoxPublicKey: keys.encryption.publicKey,
    });
    const request = prepareFolder(signer, key, {
      workspaceId,
      parentId: null,
      name: "Research",
      rootFolderId: null,
    });
    expect(decryptFolderName(key, { workspaceId, folderId: request.id }, request.encName)).toBe(
      "Research",
    );
    const signed: SignedEnvelope = {
      version: 1,
      envelope: {
        type: "folder_created",
        accountId: signer.accountId,
        workspaceId,
        folderId: request.id,
        ciphertextSha256: ciphertextSha256(fromBase64Url(request.encName)),
        createdAt: request.signedAt,
      },
      signature: request.signature,
    };
    expect(verifyEnvelope(signed, keys.signing.publicKey)).toBe(true);
  });
});
