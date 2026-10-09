import { beforeAll, describe, expect, it } from "vitest";

import {
  type ConnectPayload,
  createConnectSecret,
  openConnectPayload,
  sealConnectPayload,
} from "./connect.js";
import {
  type AccountKeys,
  type BoxKeyPair,
  createAccountKeys,
  createAgentKeyPair,
} from "./keys.js";
import { signKeyGeneration, wrapAndSignWorkspaceKey } from "./signed-wrap.js";
import { ready } from "./sodium.js";
import { createWorkspaceKey, type WorkspaceKey } from "./workspace-keys.js";

beforeAll(ready);

describe("connect payload", () => {
  let owner: AccountKeys;
  let cli: BoxKeyPair;
  let secret: Uint8Array;
  let key: WorkspaceKey;
  let payload: ConnectPayload;
  const ids = {
    accountId: "usr_owner",
    workspaceId: "ws_1",
    holder: "tok_0000000000000000000000000a",
  };
  beforeAll(() => {
    owner = createAccountKeys();
    cli = createAgentKeyPair();
    secret = createConnectSecret();
    key = createWorkspaceKey();
    payload = {
      token: "kt_agent_token",
      ownerSigningPublicKey: owner.signing.publicKey,
      signedWrappedKey: wrapAndSignWorkspaceKey(key, cli.publicKey, {
        ...ids,
        signing: owner.signing,
      }),
    };
  });

  const expectCode = (run: () => unknown, code: string) => {
    expect(run).toThrow(expect.objectContaining({ code }));
  };

  it("delivers the token, owner key and workspace key to the CLI", () => {
    const sealed = sealConnectPayload(payload, { secret, cliPublicKey: cli.publicKey });
    const opened = openConnectPayload(sealed, { secret, keyPair: cli });
    expect(opened.token).toBe("kt_agent_token");
    expect(opened.ownerSigningPublicKey).toEqual(owner.signing.publicKey);
    expect(opened).toMatchObject({ ownerAccountId: ids.accountId, workspaceId: ids.workspaceId });
    expect(opened.workspaceKey).toEqual(key);
    expect(opened.confirmationCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it("refuses a payload a relaying server forged without the fragment's secret", () => {
    const server = createAccountKeys();
    const planted = createWorkspaceKey();
    const forged: ConnectPayload = {
      token: "kt_server_token",
      ownerSigningPublicKey: server.signing.publicKey,
      signedWrappedKey: wrapAndSignWorkspaceKey(planted, cli.publicKey, {
        ...ids,
        signing: server.signing,
      }),
    };
    const sealed = sealConnectPayload(forged, {
      secret: createConnectSecret(),
      cliPublicKey: cli.publicKey,
    });
    expectCode(() => openConnectPayload(sealed, { secret, keyPair: cli }), "decryption_failed");
  });

  it("refuses tampering and a payload sealed for another CLI", () => {
    const sealed = sealConnectPayload(payload, { secret, cliPublicKey: cli.publicKey });
    for (const index of [1, 30, sealed.length - 1]) {
      const tampered = sealed.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      expectCode(() => openConnectPayload(tampered, { secret, keyPair: cli }), "decryption_failed");
    }
    const other = createAgentKeyPair();
    expectCode(() => openConnectPayload(sealed, { secret, keyPair: other }), "decryption_failed");
    expectCode(
      () => openConnectPayload(sealed.subarray(0, 10), { secret, keyPair: cli }),
      "malformed_envelope",
    );
  });

  it("still requires the owner's signature on the wrapped key", () => {
    const stranger = createAccountKeys();
    const mismatched: ConnectPayload = {
      ...payload,
      ownerSigningPublicKey: stranger.signing.publicKey,
    };
    const sealed = sealConnectPayload(mismatched, { secret, cliPublicKey: cli.publicKey });
    expectCode(() => openConnectPayload(sealed, { secret, keyPair: cli }), "invalid_signature");
    const forOther: ConnectPayload = {
      ...payload,
      signedWrappedKey: wrapAndSignWorkspaceKey(key, createAgentKeyPair().publicKey, {
        ...ids,
        signing: owner.signing,
      }),
    };
    const sealedOther = sealConnectPayload(forOther, { secret, cliPublicKey: cli.publicKey });
    expectCode(
      () => openConnectPayload(sealedOther, { secret, keyPair: cli }),
      "invalid_signature",
    );
  });

  it("requires the owner's signature on the key generation", () => {
    const forged: ConnectPayload = {
      ...payload,
      signedWrappedKey: {
        ...payload.signedWrappedKey,
        signedGeneration: signKeyGeneration(
          { ...ids, recipients: [cli.publicKey], key },
          createAccountKeys().signing,
        ),
      },
    };
    const sealed = sealConnectPayload(forged, { secret, cliPublicKey: cli.publicKey });
    expectCode(() => openConnectPayload(sealed, { secret, keyPair: cli }), "invalid_signature");
    const missing = {
      ...payload,
      signedWrappedKey: { ...payload.signedWrappedKey, signedGeneration: null },
    } as unknown as ConnectPayload;
    const sealedMissing = sealConnectPayload(missing, { secret, cliPublicKey: cli.publicKey });
    expectCode(
      () => openConnectPayload(sealedMissing, { secret, keyPair: cli }),
      "malformed_envelope",
    );
  });

  it("refuses a malformed secret", () => {
    expectCode(
      () =>
        sealConnectPayload(payload, { secret: new Uint8Array(16), cliPublicKey: cli.publicKey }),
      "invalid_input",
    );
  });
});
