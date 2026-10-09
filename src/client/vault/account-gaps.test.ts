import { beforeAll, describe, expect, it } from "vitest";

import {
  accountPublicKeys,
  createAccount,
  createWorkspaceKey,
  deriveRecoverySecrets,
  fromBase64Url,
  isCryptoError,
  parseRecoveryCode,
  ready,
  toBase64Url,
  unwrapAccountKeys,
} from "../../crypto/index.js";
import { newId } from "../platform/ids.js";
import { World } from "../testing/world.js";
import { fromPasswordKdfParams } from "./account.js";
import { decryptAgentName, encryptAgentName } from "./content.js";
import {
  MemoryTrustStorage,
  prepareRecoveryKeyReplacement,
  RecoveryKeyReplacementError,
  replaceRecoveryKey,
  sendRecoveryKeyReplacement,
  TrustState,
} from "./index.js";

beforeAll(ready);

const PASSWORD = "correct horse battery staple";

describe("replacing the recovery key while signed in", () => {
  it("proves the current password and wraps the same keys for a new recovery code", async () => {
    const account = createAccount(PASSWORD);
    const kdf = fromPasswordKdfParams(account.kdfParams);
    const trust = new TrustState(new MemoryTrustStorage());
    const current = { password: PASSWORD, kdf, email: "maya@example.com", trust };
    const { request, recoveryCode } = await prepareRecoveryKeyReplacement(account.keys, current);
    expect(request.currentLoginHash).toBe(toBase64Url(account.loginHash));
    const secrets = deriveRecoverySecrets(parseRecoveryCode(recoveryCode));
    expect(request.recoveryAuthHash).toBe(toBase64Url(secrets.authHash));
    const unwrapped = unwrapAccountKeys(
      fromBase64Url(request.wrappedByRecovery.encSecretKeys),
      secrets.keyEncryptionKey,
      "recovery",
      account.publicKeys,
    );
    expect(accountPublicKeys(unwrapped)).toEqual(account.publicKeys);

    // weaker parameters than this device saw for the email are refused before any work
    await trust.recordKdfParams("maya@example.com", kdf);
    const weaker = { ...kdf, opsLimit: kdf.opsLimit - 1 };
    const refused = await prepareRecoveryKeyReplacement(account.keys, {
      ...current,
      kdf: weaker,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
  });

  it("retries a lost answer with the same request", async () => {
    const account = createAccount(PASSWORD);
    const kdf = fromPasswordKdfParams(account.kdfParams);
    const world = new World();
    const api = world.web().api;
    world.server.tamper.refuse = (route) =>
      route === "replaceRecoveryKey" ? "unavailable" : undefined;
    const current = {
      password: PASSWORD,
      kdf,
      email: "maya@example.com",
      trust: new TrustState(new MemoryTrustStorage()),
    };
    const failed = await replaceRecoveryKey(api, account.keys, current).catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(RecoveryKeyReplacementError);
    const { replacement } = failed as RecoveryKeyReplacementError;
    delete world.server.tamper.refuse;
    expect(await sendRecoveryKeyReplacement(api, replacement)).toBe(replacement.recoveryCode);
    expect(await sendRecoveryKeyReplacement(api, replacement)).toBe(replacement.recoveryCode);
    expect(world.server.recoveryKeyReplacements).toEqual([
      replacement.request,
      replacement.request,
    ]);
  });
});

describe("agent names", () => {
  it("encrypts a name bound to its token", () => {
    const key = createWorkspaceKey();
    const ref = { workspaceId: newId("ws"), tokenId: newId("tok") };
    const encName = encryptAgentName(key, ref, "Laptop · Claude Code");
    expect(decryptAgentName(key, ref, encName)).toBe("Laptop · Claude Code");
    let refused: unknown = null;
    try {
      decryptAgentName(key, { ...ref, tokenId: newId("tok") }, encName);
    } catch (error) {
      refused = error;
    }
    expect(isCryptoError(refused, "decryption_failed")).toBe(true);
  });
});
