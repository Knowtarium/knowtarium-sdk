import { beforeAll, describe, expect, it } from "vitest";

import type { JsonObject } from "./canonical-json.js";
import { fromBase64Url, toBase64Url } from "./encoding.js";
import { encryptText } from "./envelope.js";
import { ciphertextSha256, sha256 } from "./hash.js";
import { createAccountKeys, type SigningKeyPair } from "./keys.js";
import { signEvent, verifyEvent } from "./sign.js";
import {
  type SignedEnvelope,
  type SignedEnvelopeFields,
  signEnvelope,
  verifyEnvelope,
  verifyEnvelopeFor,
} from "./signed-envelope.js";
import { ready } from "./sodium.js";
import { createWorkspaceKey } from "./workspace-keys.js";

beforeAll(ready);

describe("signed envelopes", () => {
  let person: SigningKeyPair;
  let agentOrOther: SigningKeyPair;
  let ciphertext: Uint8Array;
  let approval: SignedEnvelopeFields;
  beforeAll(() => {
    person = createAccountKeys().signing;
    agentOrOther = createAccountKeys().signing;
    ciphertext = encryptText(createWorkspaceKey(), "approved note body", {
      kind: "note",
      workspaceId: "ws_1",
      id: "note_1",
    });
    approval = {
      type: "approved",
      accountId: "usr_1",
      workspaceId: "ws_1",
      noteId: "note_1",
      pendingId: "pc_1",
      version: 5,
      folderId: "fld_1",
      ciphertextSha256: ciphertextSha256(ciphertext),
      createdAt: new Date(0).toISOString(),
    };
  });

  it("binds an approval to the exact ciphertext", () => {
    const signed = signEnvelope(approval, person);
    expect(verifyEnvelope(signed, person.publicKey)).toBe(true);
    expect(signed.envelope.ciphertextSha256).toBe(ciphertextSha256(ciphertext));
    const other = ciphertext.slice();
    other[40] = (other[40] ?? 0) ^ 1;
    expect(ciphertextSha256(other)).not.toBe(signed.envelope.ciphertextSha256);
  });

  it("verifies after a JSON round trip, whatever the key order", () => {
    const signed = signEnvelope(approval, person);
    const received = JSON.parse(JSON.stringify(signed)) as SignedEnvelope;
    expect(verifyEnvelope(received, person.publicKey)).toBe(true);
    const reordered = Object.fromEntries(
      Object.entries(approval).reverse(),
    ) as SignedEnvelopeFields;
    expect(verifyEnvelope({ ...signed, envelope: reordered }, person.publicKey)).toBe(true);
  });

  it("rejects any changed, added or removed field", () => {
    const signed = signEnvelope(approval, person);
    const variants = [
      { ...approval, version: 6 },
      { ...approval, pendingId: "pc_2" },
      { ...approval, accountId: "usr_2" },
      { ...approval, ciphertextSha256: ciphertextSha256(new Uint8Array()) },
      { ...approval, type: "rejected" },
      Object.fromEntries(Object.entries(approval).filter(([key]) => key !== "version")),
      { ...approval, noteId: "note_2" },
      { ...approval, extra: "x" },
    ] as SignedEnvelopeFields[];
    for (const envelope of variants) {
      expect(verifyEnvelope({ ...signed, envelope }, person.publicKey)).toBe(false);
    }
  });

  it("rejects forgeries by another key and tampered signatures", () => {
    expect(verifyEnvelope(signEnvelope(approval, agentOrOther), person.publicKey)).toBe(false);
    const signed = signEnvelope(approval, person);
    const bits = fromBase64Url(signed.signature);
    bits[0] = (bits[0] ?? 0) ^ 1;
    expect(verifyEnvelope({ ...signed, signature: toBase64Url(bits) }, person.publicKey)).toBe(
      false,
    );
    const malformed = [
      { ...signed, version: 2 },
      { ...signed, signature: "" },
      { ...signed, signature: null },
      { version: 1, signature: signed.signature },
    ] as unknown as SignedEnvelope[];
    for (const value of malformed) expect(verifyEnvelope(value, person.publicKey)).toBe(false);
  });

  it("keeps envelope and event signatures apart", () => {
    const event = signEvent(approval as unknown as JsonObject, person);
    expect(verifyEvent(event, person.publicKey)).toBe(true);
    expect(
      verifyEnvelope(
        { version: 1, envelope: approval, signature: event.signature },
        person.publicKey,
      ),
    ).toBe(false);
  });

  it("refuses to sign malformed fields", () => {
    for (const createdAt of [
      "yesterday",
      "2026-09-30T12:00:00Z",
      "2026-09-30T12:00:00.000123Z",
      "2026-02-30T12:00:00.000Z",
      "2026-09-30T24:00:00.000Z",
    ]) {
      expect(() => signEnvelope({ ...approval, createdAt }, person), createdAt).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
  });
});

describe("signed envelope types", () => {
  let person: SigningKeyPair;
  beforeAll(() => {
    person = createAccountKeys().signing;
  });
  const base = { accountId: "usr_1", workspaceId: "ws_1", createdAt: "2026-09-30T12:00:00.000Z" };
  const hash = "a".repeat(64);

  it("requires each type's fields and refuses unknown ones", () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ type: "edited", noteId: "n", version: 1, folderId: "f", ciphertextSha256: hash }, true],
      [{ type: "edited", noteId: "n", version: 0, folderId: "f", ciphertextSha256: hash }, true],
      [{ type: "edited", noteId: "n", version: 1, ciphertextSha256: hash }, false],
      [{ type: "deleted", noteId: "n", version: 3 }, true],
      [{ type: "deleted", noteId: "n" }, false],
      [{ type: "deleted", noteId: "n", version: 3, ciphertextSha256: hash }, false],
      [
        {
          type: "approved",
          noteId: "n",
          pendingId: "p",
          version: 2,
          folderId: "f",
          ciphertextSha256: hash,
        },
        true,
      ],
      [
        { type: "approved", pendingId: "p", version: 2, folderId: "f", ciphertextSha256: hash },
        false,
      ],
      [
        { type: "approved", noteId: "n", pendingId: "p", version: 2, ciphertextSha256: hash },
        false,
      ],
      [
        {
          type: "approved",
          noteId: "n",
          pendingId: "p",
          version: 2,
          folderId: "f",
          ciphertextSha256: hash,
          eventId: "e",
        },
        false,
      ],
      [{ type: "approved", noteId: "n", pendingId: "p", ciphertextSha256: hash }, false],
      [{ type: "rejected", noteId: "n", pendingId: "p" }, true],
      [{ type: "rejected", pendingId: "p" }, false],
      [
        { type: "rejected", noteId: "n", pendingId: "p", commentId: "c", ciphertextSha256: hash },
        true,
      ],
      [{ type: "rejected", noteId: "n", pendingId: "p", commentId: "c" }, false],
      [{ type: "rejected", noteId: "n", pendingId: "p", ciphertextSha256: hash }, false],
      [{ type: "rejected" }, false],
      [{ type: "commented", commentId: "c", revision: 0, ciphertextSha256: hash }, true],
      [{ type: "commented", commentId: "c", revision: 0 }, false],
      [
        { type: "commented", noteId: "n", commentId: "c", revision: 0, ciphertextSha256: hash },
        true,
      ],
      [{ type: "commented", commentId: "c", revision: -1, ciphertextSha256: hash }, false],
      [{ type: "commented", commentId: "c", ciphertextSha256: hash }, false],
      [{ type: "recorded", eventId: "e", ciphertextSha256: hash }, true],
      [{ type: "recorded", eventId: "e" }, false],
      [{ type: "recorded", noteId: "n", eventId: "e", ciphertextSha256: hash }, true],
      [{ type: "recorded", noteId: "", eventId: "e", ciphertextSha256: hash }, false],
      [{ type: "recorded", eventId: "e", ciphertextSha256: hash, mood: "happy" }, false],
      [
        {
          type: "wrapped_key",
          recipient: "r",
          holder: "account",
          generation: 1,
          ciphertextSha256: hash,
        },
        true,
      ],
      [
        {
          type: "wrapped_key",
          recipient: "r",
          holder: "tok_4gj699754njtbsh6ctkee9v7mz",
          generation: 1,
          ciphertextSha256: hash,
        },
        true,
      ],
      [{ type: "wrapped_key", recipient: "r", generation: 1, ciphertextSha256: hash }, false],
      [
        {
          type: "wrapped_key",
          recipient: "r",
          holder: "acc_1",
          generation: 1,
          ciphertextSha256: hash,
        },
        false,
      ],
      [
        {
          type: "wrapped_key",
          recipient: "r",
          holder: "account",
          generation: 0,
          ciphertextSha256: hash,
        },
        false,
      ],
      [{ type: "key_generation", generation: 3, recipientsHash: hash, keyCommitment: hash }, true],
      [{ type: "key_generation", generation: 3, recipientsHash: hash }, false],
      [{ type: "key_generation", generation: 3, recipientsHash: hash, keyCommitment: "AB" }, false],
      [{ type: "key_generation", generation: 3 }, false],
      [{ type: "key_generation", generation: 3, recipientsHash: "AB" }, false],
      [
        {
          type: "key_generation",
          generation: 3,
          recipientsHash: hash,
          keyCommitment: hash,
          noteId: "n",
        },
        false,
      ],
      [{ type: "token_revoked", recipient: "r", tokenId: "t" }, true],
      [{ type: "token_revoked", recipient: "r" }, false],
      [{ type: "token_revoked", tokenId: "t" }, false],
      [{ type: "folder_created", folderId: "f", ciphertextSha256: hash }, true],
      [{ type: "folder_created", folderId: "f" }, false],
      [{ type: "folder_created", folderId: "f", parentId: "g", ciphertextSha256: hash }, true],
      [{ type: "folder_moved", folderId: "f" }, true],
      [{ type: "folder_moved", folderId: "f", parentId: "g" }, true],
      [{ type: "folder_moved", folderId: "f", parentId: "" }, false],
      [
        {
          type: "edited",
          noteId: "n",
          version: 1,
          folderId: "f",
          parentId: "g",
          ciphertextSha256: hash,
        },
        false,
      ],
      [{ type: "note.edited", noteId: "n" }, false],
    ];
    for (const [fields, valid] of cases) {
      const run = () =>
        signEnvelope({ ...base, ...fields } as unknown as SignedEnvelopeFields, person);
      if (valid) expect(run, JSON.stringify(fields)).not.toThrow();
      else
        expect(run, JSON.stringify(fields)).toThrow(
          expect.objectContaining({ code: "invalid_input" }),
        );
    }
  });

  it("verifyEnvelopeFor compares every expected field", () => {
    const fields: SignedEnvelopeFields = {
      ...base,
      type: "edited",
      noteId: "n",
      version: 4,
      folderId: "f",
      ciphertextSha256: hash,
    };
    const signed = signEnvelope(fields, person);
    expect(verifyEnvelopeFor(signed, person.publicKey, fields)).toBe(true);
    expect(verifyEnvelopeFor(signed, person.publicKey, { type: "edited", noteId: "n" })).toBe(true);
    const wrong: Partial<SignedEnvelopeFields>[] = [
      { noteId: "m" },
      { version: 5 },
      { folderId: "g" },
      { ciphertextSha256: "b".repeat(64) },
      { workspaceId: "ws_2" },
      { accountId: "usr_2" },
    ];
    for (const change of wrong) {
      expect(verifyEnvelopeFor(signed, person.publicKey, { type: "edited", ...change })).toBe(
        false,
      );
    }
    expect(verifyEnvelopeFor(signed, person.publicKey, { type: "approved" })).toBe(false);
    expect(verifyEnvelopeFor(signed, createAccountKeys().signing.publicKey, fields)).toBe(false);
  });
});

describe("sha256", () => {
  it("hashes with SHA-256", () => {
    expect(sha256(new Uint8Array())).toHaveLength(32);
    expect(ciphertextSha256(Uint8Array.of(0x61, 0x62, 0x63))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
