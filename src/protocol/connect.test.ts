import { describe, expect, it } from "vitest";

import {
  AgentToken,
  ApproveConnectRequest,
  ApproveExtensionConnectRequest,
  ConnectRequestInfo,
  PollConnectResponse,
  RelayConnectRequest,
  routes,
  StartConnectRequest,
} from "./index.js";
import { b64, ct, id, now, signing } from "./test-fixtures.js";

const token = {
  id: id("tok"),
  workspaceId: id("ws"),
  encName: ct,
  access: "read-write",
  folderIds: [id("fld")],
  publicKey: b64(32),
  signPublicKey: null,
  createdAt: now,
  lastUsedAt: null,
  revokedAt: null,
};

describe("connect flow", () => {
  it("starts with the CLI version only: the public key stays in the URL fragment", () => {
    expect(StartConnectRequest.safeParse({ cliVersion: "0.1.0" }).success).toBe(true);
    expect(StartConnectRequest.safeParse({ cliVersion: "0.1.0", publicKey: b64(32) }).success).toBe(
      false,
    );
    expect(StartConnectRequest.safeParse({ cliVersion: "latest" }).success).toBe(false);
  });

  it("shows the page no key and no code", () => {
    const info = {
      id: id("cr"),
      cliVersion: "0.1.0",
      status: "pending",
      createdAt: now,
      expiresAt: now,
    };
    // a server from before the web clipper sends no `client`: the request is the CLI's
    expect(ConnectRequestInfo.parse({ ...info, publicKey: b64(32) })).toEqual({
      ...info,
      client: "cli",
    });
    const extension = { ...info, client: "extension" };
    expect(ConnectRequestInfo.parse(extension)).toEqual(extension);
    expect(ConnectRequestInfo.safeParse({ ...info, client: "browser" }).success).toBe(false);
  });

  it("starts a request for the CLI or for an extension, never a mix", () => {
    expect(StartConnectRequest.safeParse({ cliVersion: "0.1.4" }).success).toBe(true);
    expect(
      StartConnectRequest.safeParse({ client: "extension", extensionVersion: "0.1.0" }).success,
    ).toBe(true);
    for (const bad of [
      { client: "extension", cliVersion: "0.1.0" },
      { client: "cli", extensionVersion: "0.1.0" },
      { client: "extension", extensionVersion: "latest" },
      { cliVersion: "0.1.4", extensionVersion: "0.1.0" },
      {},
    ]) {
      expect(StartConnectRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("approves an extension with its id, its token's hash and the owner's extension_key", () => {
    const body = {
      extensionId: id("ext"),
      tokenSecretSha256: b64(32),
      workspaceId: id("ws"),
      encName: ct,
      signPublicKey: b64(32),
      keySignedAt: now,
      keySignature: b64(64),
    };
    expect(ApproveExtensionConnectRequest.parse(body)).toEqual(body);
    expect(
      ApproveExtensionConnectRequest.safeParse({ ...body, extensionId: id("tok") }).success,
    ).toBe(false);
    // no workspace key copy and no scope: an extension never holds either
    for (const extra of [{ encWorkspaceKey: b64(80) }, { folderIds: [] }, { access: "read" }]) {
      expect(ApproveExtensionConnectRequest.safeParse({ ...body, ...extra }).success).toBe(false);
    }
    expect(routes.approveExtensionConnect.path).toBe(
      "/connect-requests/:requestId/extension-approval",
    );
    expect(routes.approveExtensionConnect.auth).toBe("session");
  });

  it("approves with the token id, the scope, the key from the fragment and a signed wrapped key", () => {
    const body = {
      tokenId: id("tok"),
      tokenSecretSha256: b64(32),
      workspaceId: id("ws"),
      access: "read",
      folderIds: [],
      encName: ct,
      publicKey: b64(32),
      keyGeneration: 1,
      encWorkspaceKey: b64(80),
      ...signing,
      keyCommitment: "0".repeat(64),
      generationSignedAt: signing.signedAt,
      generationSignature: signing.signature,
    };
    expect(ApproveConnectRequest.safeParse(body).success).toBe(true);
    expect(ApproveConnectRequest.safeParse({ ...body, access: "admin" }).success).toBe(false);
    expect(ApproveConnectRequest.safeParse({ ...body, signature: undefined }).success).toBe(false);
    expect(ApproveConnectRequest.safeParse({ ...body, tokenId: undefined }).success).toBe(false);
    const withSecret = { ...body, tokenSecret: `kta_${b64(32)}` };
    expect(ApproveConnectRequest.safeParse(withSecret).success).toBe(false);

    // protocol 2: the agent's signing key with the owner's agent_key signature, all or none
    const agentKey = {
      signPublicKey: b64(32),
      agentKeySignedAt: signing.signedAt,
      agentKeySignature: signing.signature,
    };
    expect(ApproveConnectRequest.safeParse({ ...body, ...agentKey }).success).toBe(true);
    for (const field of Object.keys(agentKey)) {
      const partial = { ...body, ...agentKey, [field]: undefined };
      expect(ApproveConnectRequest.safeParse(partial).success, field).toBe(false);
    }
    const shortKey = { ...body, ...agentKey, signPublicKey: b64(31) };
    expect(ApproveConnectRequest.safeParse(shortKey).success).toBe(false);
  });

  it("answers a poll by status, with a sealed payload only when relayed", () => {
    for (const status of ["pending", "approved"]) {
      expect(PollConnectResponse.safeParse({ status, pollIntervalSeconds: 2 }).success).toBe(true);
    }
    expect(PollConnectResponse.safeParse({ status: "relayed", encRelayPayload: ct }).success).toBe(
      true,
    );
    expect(PollConnectResponse.safeParse({ status: "relayed" }).success).toBe(false);
    expect(
      PollConnectResponse.safeParse({ status: "relayed", encRelayPayload: '{"token":1}' }).success,
    ).toBe(false);
    for (const status of ["denied", "expired", "completed"]) {
      expect(PollConnectResponse.safeParse({ status }).success).toBe(true);
    }
  });

  it("relays only ciphertext", () => {
    expect(RelayConnectRequest.safeParse({ encRelayPayload: ct }).success).toBe(true);
    expect(RelayConnectRequest.safeParse({ encRelayPayload: ct, tokenSecret: "x" }).success).toBe(
      false,
    );
  });

  it("describes a token by ids, access and public key", () => {
    expect(AgentToken.safeParse(token).success).toBe(true);
    expect(AgentToken.safeParse({ ...token, access: "write" }).success).toBe(false);
    // the agent's signing key: null for a token connected before protocol 2
    expect(AgentToken.safeParse({ ...token, signPublicKey: b64(32) }).success).toBe(true);
    expect(AgentToken.safeParse({ ...token, signPublicKey: b64(31) }).success).toBe(false);
    // and absent from a server older than protocol 2
    const { signPublicKey: _key, ...older } = token;
    expect(_key).toBeNull();
    expect(AgentToken.safeParse(older).success).toBe(true);
  });
});
