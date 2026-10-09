import { beforeAll, describe, expect, it } from "vitest";

import { type JsonObject } from "./canonical-json.js";
import { toBase64Url, fromBase64Url } from "./encoding.js";
import { createAccountKeys, type SigningKeyPair } from "./keys.js";
import { type SignedEvent, signEvent, verifyEvent } from "./sign.js";
import { ready } from "./sodium.js";

beforeAll(ready);

describe("signed events", () => {
  let person: SigningKeyPair;
  let other: SigningKeyPair;
  const approval = {
    type: "approved",
    actor: "human:usr_1",
    note: "note_1",
    pendingChange: "pc_1",
    version: 4,
    at: "2026-09-30T12:00:00Z",
  };
  beforeAll(() => {
    person = createAccountKeys().signing;
    other = createAccountKeys().signing;
  });

  it("signs and verifies, independent of key order", () => {
    const signed = signEvent(approval, person);
    expect(signed.version).toBe(1);
    expect(fromBase64Url(signed.signature)).toHaveLength(64);
    expect(verifyEvent(signed, person.publicKey)).toBe(true);
    const reordered = { ...signed, event: Object.fromEntries(Object.entries(approval).reverse()) };
    expect(verifyEvent(reordered, person.publicKey)).toBe(true);
  });

  it("survives a JSON round trip (stored encrypted, read back)", () => {
    const signed = signEvent(approval, person);
    const stored = JSON.parse(JSON.stringify(signed)) as SignedEvent;
    expect(verifyEvent(stored, person.publicKey)).toBe(true);
  });

  it("rejects a changed field, an added field and a removed field", () => {
    const signed = signEvent(approval, person);
    const changes: JsonObject[] = [
      { ...approval, version: 5 },
      { ...approval, actor: "human:usr_2" },
      { ...approval, extra: true },
      Object.fromEntries(Object.entries(approval).filter(([key]) => key !== "at")),
    ];
    for (const event of changes)
      expect(verifyEvent({ ...signed, event }, person.publicKey)).toBe(false);
  });

  it("rejects forgeries: another signer, a moved signature, a flipped bit", () => {
    const signed = signEvent(approval, person);
    // an agent holding the workspace key but not the person's signing key
    expect(verifyEvent(signEvent(approval, other), person.publicKey)).toBe(false);
    expect(verifyEvent(signed, other.publicKey)).toBe(false);
    const comment = signEvent({ type: "comment", actor: "human:usr_1", body: "hi" }, person);
    expect(verifyEvent({ ...signed, signature: comment.signature }, person.publicKey)).toBe(false);
    const bits = fromBase64Url(signed.signature);
    bits[10] = (bits[10] ?? 0) ^ 1;
    expect(verifyEvent({ ...signed, signature: toBase64Url(bits) }, person.publicKey)).toBe(false);
  });

  it("returns false for malformed input instead of throwing", () => {
    const signed = signEvent(approval, person);
    const malformed = [
      { ...signed, version: 2 },
      { ...signed, signature: "" },
      { ...signed, signature: "not base64url!" },
      { ...signed, signature: signed.signature.slice(0, 40) },
      { ...signed, signature: 42 },
      { ...signed, event: { n: 1.5 } },
      { version: 1 },
    ] as unknown as SignedEvent[];
    for (const value of malformed) expect(verifyEvent(value, person.publicKey)).toBe(false);
  });

  it("throws for a malformed public key, which is a caller bug", () => {
    expect(() => verifyEvent(signEvent(approval, person), new Uint8Array(31))).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("refuses to sign what has no canonical form", () => {
    expect(() => signEvent({ n: Number.NaN }, person)).toThrow(
      expect.objectContaining({ code: "non_canonical_json" }),
    );
  });
});
