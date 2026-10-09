import { beforeAll, describe, expect, it } from "vitest";

import { changePassword, createAccount, createRecovery } from "./account.js";
import { toHex } from "./encoding.js";
import { derivePasswordSecrets, deriveRecoverySecrets } from "./kdf.js";
import { type AccountKeys, accountPublicKeys, createAccountKeys } from "./keys.js";
import { parseRecoveryCode } from "./recovery-code.js";
import { ready } from "./sodium.js";
import { unwrapAccountKeys, wrapAccountKeys } from "./wrap.js";

beforeAll(ready);

describe("account flows", () => {
  // one sign-up shared by the tests: Argon2id is slow on purpose
  const password = "correct horse battery staple";
  let account: ReturnType<typeof createAccount>;
  beforeAll(() => {
    account = createAccount(password);
  });

  it("signs up with everything the server needs and nothing that decrypts", () => {
    expect(account.loginHash).toHaveLength(32);
    expect(account.recoveryAuthHash).toHaveLength(32);
    expect(account.wrappedByPassword).toHaveLength(105);
    expect(account.wrappedByRecovery).toHaveLength(105);
    expect(account.publicKeys).toEqual(accountPublicKeys(account.keys));
    // what the server stores is JSON-safe apart from the byte arrays, and contains no private key
    const serverView = [
      account.loginHash,
      account.recoveryAuthHash,
      account.wrappedByPassword,
      account.wrappedByRecovery,
    ].map(toHex);
    for (const secret of [account.keys.encryption.privateKey, account.keys.signing.privateKey]) {
      const hex = toHex(secret.subarray(0, 32));
      for (const stored of serverView) expect(stored).not.toContain(hex);
    }
  });

  it("signs in on a new device: params, then login hash, then unwrap", () => {
    const secrets = derivePasswordSecrets(password, account.kdfParams);
    expect(secrets.authHash).toEqual(account.loginHash);
    const keys = unwrapAccountKeys(
      account.wrappedByPassword,
      secrets.keyEncryptionKey,
      "password",
      account.publicKeys,
    );
    expect(keys.encryption.privateKey).toEqual(account.keys.encryption.privateKey);
    expect(keys.signing.privateKey).toEqual(account.keys.signing.privateKey);
  });

  it("fails to unwrap with a wrong password", () => {
    const wrong = derivePasswordSecrets("correct horse battery stapler", account.kdfParams);
    expect(wrong.authHash).not.toEqual(account.loginHash);
    expect(() =>
      unwrapAccountKeys(
        account.wrappedByPassword,
        wrong.keyEncryptionKey,
        "password",
        account.publicKeys,
      ),
    ).toThrow(expect.objectContaining({ code: "decryption_failed" }));
  });

  it("recovers with the recovery code, then sets a new password", () => {
    const recoveryKey = parseRecoveryCode(account.recoveryCode.toLowerCase());
    const recovery = deriveRecoverySecrets(recoveryKey);
    expect(recovery.authHash).toEqual(account.recoveryAuthHash);
    const keys = unwrapAccountKeys(
      account.wrappedByRecovery,
      recovery.keyEncryptionKey,
      "recovery",
      account.publicKeys,
    );
    expect(keys.encryption.privateKey).toEqual(account.keys.encryption.privateKey);

    const next = changePassword(keys, "a brand new passphrase");
    expect(next.kdfParams.salt).not.toBe(account.kdfParams.salt);
    const signIn = derivePasswordSecrets("a brand new passphrase", next.kdfParams);
    expect(signIn.authHash).toEqual(next.loginHash);
    const reopened = unwrapAccountKeys(
      next.wrappedByPassword,
      signIn.keyEncryptionKey,
      "password",
      account.publicKeys,
    );
    expect(reopened.signing.publicKey).toEqual(account.keys.signing.publicKey);
    // the old password no longer opens the new copy
    const old = derivePasswordSecrets(password, next.kdfParams);
    expect(() =>
      unwrapAccountKeys(
        next.wrappedByPassword,
        old.keyEncryptionKey,
        "password",
        account.publicKeys,
      ),
    ).toThrow(expect.objectContaining({ code: "decryption_failed" }));
  });

  it("replaces a lost recovery code without touching the password copy", () => {
    const fresh = createRecovery(account.keys);
    expect(fresh.recoveryCode).not.toBe(account.recoveryCode);
    const secrets = deriveRecoverySecrets(parseRecoveryCode(fresh.recoveryCode));
    expect(
      unwrapAccountKeys(
        fresh.wrappedByRecovery,
        secrets.keyEncryptionKey,
        "recovery",
        account.publicKeys,
      ).encryption.publicKey,
    ).toEqual(account.publicKeys.encryptionPublicKey);
    const stale = deriveRecoverySecrets(parseRecoveryCode(account.recoveryCode));
    expect(() =>
      unwrapAccountKeys(
        fresh.wrappedByRecovery,
        stale.keyEncryptionKey,
        "recovery",
        account.publicKeys,
      ),
    ).toThrow(expect.objectContaining({ code: "decryption_failed" }));
  });
});

describe("unwrapAccountKeys", () => {
  const kek = new Uint8Array(32).fill(3);
  let keys: AccountKeys;
  let wrapped: Uint8Array;
  const own = () => accountPublicKeys(keys);
  beforeAll(() => {
    keys = createAccountKeys();
    wrapped = wrapAccountKeys(keys, kek, "password");
  });

  it("refuses the copy of the other purpose", () => {
    expect(unwrapAccountKeys(wrapped, kek, "password", own()).signing.publicKey).toEqual(
      keys.signing.publicKey,
    );
    expect(() => unwrapAccountKeys(wrapped, kek, "recovery", own())).toThrow(
      expect.objectContaining({ code: "decryption_failed" }),
    );
  });

  it("throws key_mismatch when the keys belong to another account", () => {
    const other = accountPublicKeys(createAccountKeys());
    expect(() => unwrapAccountKeys(wrapped, kek, "password", other)).toThrow(
      expect.objectContaining({ code: "key_mismatch" }),
    );
    // a mixed pair (right encryption key, wrong signing key) is refused too
    const mixed = { ...own(), signingPublicKey: other.signingPublicKey };
    expect(() => unwrapAccountKeys(wrapped, kek, "password", mixed)).toThrow(
      expect.objectContaining({ code: "key_mismatch" }),
    );
  });

  it("detects tampering, wrong lengths and unknown versions", () => {
    for (const index of [1, 24, 25, 60, 104]) {
      const tampered = wrapped.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      expect(() => unwrapAccountKeys(tampered, kek, "password", own())).toThrow(
        expect.objectContaining({ code: "decryption_failed" }),
      );
    }
    const versioned = wrapped.slice();
    versioned[0] = 2;
    expect(() => unwrapAccountKeys(versioned, kek, "password", own())).toThrow(
      expect.objectContaining({ code: "unsupported_version" }),
    );
    expect(() => unwrapAccountKeys(wrapped.subarray(1), kek, "password", own())).toThrow(
      expect.objectContaining({ code: "malformed_envelope" }),
    );
  });
});
