import { describe, expect, it } from "vitest";

import {
  canonicalEnvelope,
  ENVELOPE_SIGNING_PREFIX,
  envelopeSigningText,
  formatVersionTag,
  envelopeProtocolVersion,
  parseResponseVersionTag,
  parseVersionTag,
  PROTOCOL_2_ENVELOPE_TYPES,
  PROTOCOL_VERSION,
  SignedAgentKey,
  SignedAgentPolicy,
  SignedEnvelope,
  SignedEvent,
  SigningHeaders,
} from "./index.js";
import { b64, id, now, sha256Hex } from "./test-fixtures.js";

const base = { accountId: id("acc"), workspaceId: id("ws"), createdAt: now };
const hash = sha256Hex;

const valid = [
  {
    type: "edited",
    ...base,
    noteId: id("note"),
    folderId: id("fld"),
    version: 4,
    ciphertextSha256: hash,
  },
  {
    type: "edited",
    ...base,
    noteId: id("note"),
    folderId: id("fld"),
    version: 0,
    ciphertextSha256: hash,
  },
  { type: "deleted", ...base, noteId: id("note"), version: 5 },
  {
    type: "approved",
    ...base,
    noteId: id("note"),
    pendingId: id("pc"),
    version: 5,
    folderId: id("fld"),
    ciphertextSha256: hash,
  },
  { type: "rejected", ...base, noteId: id("note"), pendingId: id("pc") },
  {
    type: "rejected",
    ...base,
    noteId: id("note"),
    pendingId: id("pc"),
    commentId: id("cmt"),
    ciphertextSha256: hash,
  },
  { type: "commented", ...base, commentId: id("cmt"), revision: 2, ciphertextSha256: hash },
  { type: "commented", ...base, commentId: id("cmt"), revision: 0, ciphertextSha256: hash },
  { type: "recorded", ...base, eventId: id("evt"), ciphertextSha256: hash },
  { type: "recorded", ...base, noteId: id("note"), eventId: id("evt"), ciphertextSha256: hash },
  {
    type: "commented",
    ...base,
    noteId: id("note"),
    commentId: id("cmt"),
    revision: 1,
    ciphertextSha256: hash,
  },
  {
    type: "wrapped_key",
    ...base,
    recipient: b64(32),
    holder: "account",
    generation: 1,
    ciphertextSha256: hash,
  },
  {
    type: "wrapped_key",
    ...base,
    recipient: b64(32),
    holder: id("tok"),
    generation: 1,
    ciphertextSha256: hash,
  },
  { type: "key_generation", ...base, generation: 2, recipientsHash: hash, keyCommitment: hash },
  { type: "token_revoked", ...base, recipient: b64(32), tokenId: id("tok") },
  { type: "folder_created", ...base, folderId: id("fld"), ciphertextSha256: hash },
  { type: "folder_moved", ...base, folderId: id("fld") },
  { type: "folder_moved", ...base, folderId: id("fld"), parentId: id("fld", 2) },
  {
    type: "folder_created",
    ...base,
    folderId: id("fld"),
    parentId: id("fld", 2),
    ciphertextSha256: hash,
  },
  { type: "agent_policy", ...base, revision: 1, policySha256: hash },
  { type: "agent_key", ...base, tokenId: id("tok"), signPublicKey: b64(32), policyRevision: 0 },
  {
    type: "agent_edited",
    ...base,
    tokenId: id("tok"),
    noteId: id("note"),
    folderId: id("fld"),
    version: 1,
    ciphertextSha256: hash,
    revision: 0,
    policySha256: hash,
  },
];

describe("signed envelopes", () => {
  it.each(valid)("accepts a $type envelope", (envelope) => {
    expect(SignedEnvelope.safeParse(envelope).success).toBe(true);
  });

  it.each([
    { type: "edited", ...base, noteId: id("note"), version: 4, ciphertextSha256: hash },
    { type: "approved", ...base, pendingId: id("pc"), ciphertextSha256: hash },
    { type: "approved", ...base, pendingId: id("pc"), version: 5, ciphertextSha256: hash },
    {
      type: "approved",
      ...base,
      pendingId: id("pc"),
      version: 5,
      folderId: id("fld"),
      ciphertextSha256: hash,
    },
    { type: "rejected", ...base, pendingId: id("pc") },
    { type: "rejected", ...base, noteId: id("note"), pendingId: id("pc"), ciphertextSha256: hash },
    { type: "rejected", ...base, pendingId: id("pc"), commentId: null },
    { type: "commented", ...base, ciphertextSha256: hash },
    { type: "commented", ...base, commentId: id("cmt"), ciphertextSha256: hash },
    { type: "commented", ...base, commentId: id("cmt"), revision: -1, ciphertextSha256: hash },
    { type: "commented", ...base, commentId: id("cmt"), revision: 1 },
    { type: "recorded", ...base, ciphertextSha256: hash },
    { type: "recorded", ...base, eventId: id("evt") },
    { type: "deleted", ...base, noteId: id("note"), version: 5, pendingId: id("pc") },
    { type: "deleted", ...base, noteId: id("note"), version: -1 },
    {
      type: "edited",
      ...base,
      noteId: id("note"),
      folderId: id("fld"),
      version: 4,
      ciphertextSha256: b64(32),
    },
    {
      type: "edited",
      ...base,
      noteId: id("note"),
      folderId: id("fld"),
      version: 4,
      ciphertextSha256: hash.toUpperCase(),
    },
    { type: "verified", ...base, noteId: id("note") },
    {
      type: "wrapped_key",
      ...base,
      recipient: id("tok"),
      holder: "account",
      generation: 1,
      ciphertextSha256: hash,
    },
    {
      type: "wrapped_key",
      ...base,
      recipient: b64(32),
      holder: "account",
      generation: 0,
      ciphertextSha256: hash,
    },
    { type: "wrapped_key", ...base, recipient: b64(32), generation: 1, ciphertextSha256: hash },
    {
      type: "wrapped_key",
      ...base,
      recipient: b64(32),
      holder: id("acc"),
      generation: 1,
      ciphertextSha256: hash,
    },
    { type: "key_generation", ...base, generation: 0, recipientsHash: hash, keyCommitment: hash },
    { type: "key_generation", ...base, generation: 2, recipientsHash: hash },
    { type: "key_generation", ...base, generation: 2 },
    { type: "token_revoked", ...base, recipient: b64(32) },
    { type: "token_revoked", ...base, recipient: id("tok"), tokenId: id("tok") },
    { type: "folder_created", ...base, folderId: id("fld") },
    { type: "rejected", ...base, pendingId: id("pc"), commentId: id("cmt") },
    { type: "folder_moved", ...base, folderId: id("fld"), parentId: null },
    { type: "folder_moved", ...base, folderId: id("fld"), parentId: id("note") },
    { type: "recorded", ...base, noteId: id("fld"), eventId: id("evt"), ciphertextSha256: hash },
    { type: "deleted", ...base, noteId: id("note"), version: 5, createdAt: "2026-09-30T12:00:00Z" },
    {
      type: "deleted",
      ...base,
      noteId: id("note"),
      version: 5,
      createdAt: "2026-09-30T12:00:00.000123Z",
    },
    { type: "deleted", ...base, noteId: id("note"), version: 5, accountId: id("tok") },
    { type: "agent_policy", ...base, revision: -1, policySha256: hash },
    { type: "agent_policy", ...base, revision: 1, policySha256: hash.toUpperCase() },
    { type: "agent_policy", ...base, revision: 1 },
    { type: "agent_key", ...base, tokenId: id("tok"), signPublicKey: b64(31), policyRevision: 0 },
    { type: "agent_key", ...base, tokenId: id("acc"), signPublicKey: b64(32), policyRevision: 0 },
    { type: "agent_key", ...base, signPublicKey: b64(32), policyRevision: 0 },
    { type: "agent_key", ...base, tokenId: id("tok"), signPublicKey: b64(32) },
    { type: "agent_key", ...base, tokenId: id("tok"), signPublicKey: b64(32), policyRevision: -1 },
    ...(["tokenId", "revision", "policySha256"] as const).map((field) =>
      Object.fromEntries(
        Object.entries({
          type: "agent_edited",
          ...base,
          tokenId: id("tok"),
          noteId: id("note"),
          folderId: id("fld"),
          version: 1,
          ciphertextSha256: hash,
          revision: 0,
          policySha256: hash,
        }).filter(([key]) => key !== field),
      ),
    ),
    {
      type: "agent_edited",
      ...base,
      tokenId: id("tok"),
      noteId: id("note"),
      folderId: id("fld"),
      version: 1,
      ciphertextSha256: hash,
      revision: 0,
      policySha256: hash,
      checkId: id("chk"),
    },
  ])("rejects %j", (envelope) => {
    expect(SignedEnvelope.safeParse(envelope).success).toBe(false);
  });

  it("serializes to sorted compact JSON, whatever the key order", () => {
    const envelope = {
      createdAt: now,
      ciphertextSha256: hash,
      noteId: id("note"),
      pendingId: id("pc"),
      version: 5,
      folderId: id("fld"),
      workspaceId: id("ws"),
      accountId: id("acc"),
      type: "approved",
    } as const;
    expect(canonicalEnvelope(envelope)).toBe(
      `{"accountId":"${id("acc")}","ciphertextSha256":"${hash}",` +
        `"createdAt":"${now}","folderId":"${id("fld")}","noteId":"${id("note")}",` +
        `"pendingId":"${id("pc")}",` +
        `"type":"approved","version":5,"workspaceId":"${id("ws")}"}`,
    );
  });

  it("signs the prefixed canonical text", () => {
    const envelope = { type: "folder_moved", ...base, folderId: id("fld") } as const;
    expect(ENVELOPE_SIGNING_PREFIX).toBe("knowtarium-envelope-v1\n");
    expect(envelopeSigningText(envelope)).toBe(
      `knowtarium-envelope-v1\n${canonicalEnvelope(envelope)}`,
    );
  });

  it("keeps numbers as numbers", () => {
    const text = canonicalEnvelope({ type: "deleted", ...base, noteId: id("note"), version: 5 });
    expect(text).toContain(`"type":"deleted","version":5,"workspaceId"`);
  });

  it("carries the envelope with its signature", () => {
    const envelope = valid[0];
    expect(SignedEvent.safeParse({ envelope, signature: b64(64) }).success).toBe(true);
    expect(SignedEvent.safeParse({ envelope, signature: b64(63) }).success).toBe(false);
  });

  it("reads the signing headers, in milliseconds", () => {
    const headers = { "knowtarium-signature": b64(64), "knowtarium-signed-at": now };
    expect(SigningHeaders.safeParse(headers).success).toBe(true);
    expect(SigningHeaders.safeParse({ "knowtarium-signature": b64(64) }).success).toBe(false);
    expect(
      SigningHeaders.safeParse({ ...headers, "knowtarium-signed-at": "2026-09-30T12:00:00Z" })
        .success,
    ).toBe(false);
  });
});

describe("envelope protocol versions", () => {
  it("marks the agent envelopes as protocol 2, the rest as 1", () => {
    expect([...PROTOCOL_2_ENVELOPE_TYPES].sort()).toEqual([
      "agent_edited",
      "agent_key",
      "agent_policy",
    ]);
    for (const option of SignedEnvelope.options) {
      const type = option.shape.type.value;
      expect(envelopeProtocolVersion(type), type).toBe(type.startsWith("agent_") ? 2 : 1);
      expect(envelopeProtocolVersion(type)).toBeLessThanOrEqual(PROTOCOL_VERSION);
    }
  });

  it("carries the owner's agent_policy and agent_key records with their own schemas", () => {
    const policy = valid.find((envelope) => envelope.type === "agent_policy");
    const key = valid.find((envelope) => envelope.type === "agent_key");
    expect(SignedAgentPolicy.safeParse({ envelope: policy, signature: b64(64) }).success).toBe(
      true,
    );
    expect(SignedAgentKey.safeParse({ envelope: key, signature: b64(64) }).success).toBe(true);
    expect(SignedAgentKey.safeParse({ envelope: policy, signature: b64(64) }).success).toBe(false);
  });
});

describe("version tags", () => {
  it("round-trips a version", () => {
    expect(formatVersionTag(0)).toBe('"0"');
    expect(parseVersionTag(formatVersionTag(12))).toBe(12);
  });

  it.each(["12", '"012"', 'W/"12"', "*", '"a"', ""])("rejects %j", (value) => {
    expect(parseVersionTag(value)).toBeNull();
  });

  it("reads a response's weak tag as the same version, and refuses anything else", () => {
    expect(parseResponseVersionTag('"12"')).toBe(12);
    expect(parseResponseVersionTag('W/"12"')).toBe(12);
    expect(parseResponseVersionTag(' W/"0" ')).toBe(0);
    for (const value of ["W/12", 'w/"12"', 'W/"012"', 'W/ "12"', 'W/W/"12"', "W/", "*", null]) {
      expect(parseResponseVersionTag(value)).toBeNull();
    }
  });
});
