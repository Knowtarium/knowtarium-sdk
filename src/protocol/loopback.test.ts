import { describe, expect, it } from "vitest";

import {
  ConnectDelivery,
  formatConnectFragment,
  LoopbackRequest,
  LoopbackResponse,
  loopbackConnectUrl,
  parseConnectFragment,
} from "./index.js";
import { b64, ct, id, now, signedGeneration, signedWrappedKey } from "./test-fixtures.js";

const fragment = { publicKey: b64(32), port: 51234, secret: b64(32) };

const delivery = {
  requestId: id("cr"),
  tokenSecret: `kta_${b64(32)}`,
  token: {
    id: id("tok"),
    workspaceId: id("ws"),
    encName: ct,
    access: "read-write",
    folderIds: [],
    publicKey: fragment.publicKey,
    signPublicKey: null,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  },
  ownerId: id("acc"),
  ownerSignPublicKey: b64(32),
  wrappedKey: {
    workspaceId: id("ws"),
    recipient: { kind: "token", tokenId: id("tok") },
    keyGeneration: 1,
    encWorkspaceKey: b64(80),
    createdAt: now,
    signed: signedWrappedKey(),
    signedGeneration: signedGeneration(),
  },
};

describe("connect fragment", () => {
  it("round-trips through the URL fragment", () => {
    const text = formatConnectFragment(fragment);
    expect(text).toBe(`publicKey=${fragment.publicKey}&port=51234&secret=${fragment.secret}`);
    expect(parseConnectFragment(`#${text}`)).toEqual(fragment);
    expect(parseConnectFragment(text)).toEqual(fragment);
  });

  it.each([
    "",
    `publicKey=${b64(32)}&port=51234`,
    `publicKey=${b64(32)}&port=80&secret=${b64(32)}`,
    `publicKey=${b64(32)}&port=70000&secret=${b64(32)}`,
    `publicKey=${b64(31)}&port=51234&secret=${b64(32)}`,
    `publicKey=${b64(32)}&port=51234&secret=${b64(32)}&extra=1`,
    `publicKey=${b64(32)}&publicKey=${b64(32)}&port=51234&secret=${b64(32)}`,
    `publicKey&port=51234&secret=${b64(32)}`,
  ])("rejects %j", (text) => {
    expect(parseConnectFragment(text)).toBeNull();
  });

  it("carries the CLI's signing key from protocol 2 on, and reads fragments without it", () => {
    const withKey = { ...fragment, signPublicKey: b64(32) };
    const text = formatConnectFragment(withKey);
    expect(text).toBe(
      `publicKey=${fragment.publicKey}&port=51234&secret=${fragment.secret}&signPublicKey=${withKey.signPublicKey}`,
    );
    expect(parseConnectFragment(text)).toEqual(withKey);
    expect(parseConnectFragment(formatConnectFragment(fragment))).toEqual(fragment);
    expect(
      parseConnectFragment(`${formatConnectFragment(fragment)}&signPublicKey=${b64(31)}`),
    ).toBeNull();
  });

  it("posts to the loopback address only", () => {
    expect(loopbackConnectUrl(51234)).toBe("http://127.0.0.1:51234/knowtarium/connect");
  });
});

describe("loopback delivery", () => {
  it("carries the token secret, the owner's signing key and the signed wrapped key", () => {
    expect(ConnectDelivery.safeParse(delivery).success).toBe(true);
    expect(LoopbackRequest.safeParse({ ...delivery, secret: fragment.secret }).success).toBe(true);
  });

  it("carries the owner's agent_key only for a CLI that sent its signing key", () => {
    const agentKey = {
      envelope: {
        type: "agent_key",
        accountId: id("acc"),
        workspaceId: id("ws"),
        createdAt: now,
        tokenId: id("tok"),
        signPublicKey: b64(32),
        policyRevision: 0,
      },
      signature: b64(64),
    };
    expect(ConnectDelivery.safeParse({ ...delivery, agentKey }).success).toBe(true);
    const wrongType = { ...agentKey, envelope: signedWrappedKey().envelope };
    expect(ConnectDelivery.safeParse({ ...delivery, agentKey: wrongType }).success).toBe(false);
  });

  it("needs the one-time secret on the loopback", () => {
    expect(LoopbackRequest.safeParse(delivery).success).toBe(false);
  });

  it("refuses a delivery without the owner's key or with an unsigned wrapped key", () => {
    expect(ConnectDelivery.safeParse({ ...delivery, ownerSignPublicKey: undefined }).success).toBe(
      false,
    );
    const unsigned = { ...delivery, wrappedKey: { ...delivery.wrappedKey, signed: undefined } };
    expect(ConnectDelivery.safeParse(unsigned).success).toBe(false);
  });

  it("answers ok or a known error", () => {
    expect(LoopbackResponse.safeParse({ ok: true }).success).toBe(true);
    expect(LoopbackResponse.safeParse({ ok: false, error: "bad_secret" }).success).toBe(true);
    expect(LoopbackResponse.safeParse({ ok: false, error: "nope" }).success).toBe(false);
    expect(LoopbackResponse.safeParse({ ok: false, error: "agent_key_mismatch" }).success).toBe(
      true,
    );
  });
});
