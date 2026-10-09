import { beforeAll, describe, expect, it } from "vitest";

import {
  accountPublicKeys,
  boxKeyPairFromPrivateKey,
  connectConfirmationCode,
  createAccountKeys,
  createAgentKeyPair,
  signingKeyPairFromSeed,
} from "./keys.js";
import { ready } from "./sodium.js";

beforeAll(ready);

describe("keys", () => {
  it("creates account keys: X25519 for encryption, Ed25519 for signing", () => {
    const keys = createAccountKeys();
    expect(keys.encryption.publicKey).toHaveLength(32);
    expect(keys.encryption.privateKey).toHaveLength(32);
    expect(keys.signing.publicKey).toHaveLength(32);
    expect(keys.signing.privateKey).toHaveLength(64);
    expect(accountPublicKeys(keys)).toEqual({
      encryptionPublicKey: keys.encryption.publicKey,
      signingPublicKey: keys.signing.publicKey,
    });
  });

  it("rebuilds keypairs from their private halves", () => {
    const agent = createAgentKeyPair();
    expect(boxKeyPairFromPrivateKey(agent.privateKey)).toEqual(agent);
    const { signing } = createAccountKeys();
    expect(signingKeyPairFromSeed(signing.privateKey.subarray(0, 32))).toEqual(signing);
    expect(() => boxKeyPairFromPrivateKey(new Uint8Array(16))).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("derives an 8-character confirmation code from the CLI and owner keys", () => {
    const cli = createAgentKeyPair();
    const owner = createAccountKeys().signing;
    const code = connectConfirmationCode(cli.publicKey, owner.publicKey);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(connectConfirmationCode(cli.publicKey.slice(), owner.publicKey.slice())).toBe(code);
    expect(connectConfirmationCode(createAgentKeyPair().publicKey, owner.publicKey)).not.toBe(code);
    expect(connectConfirmationCode(cli.publicKey, createAccountKeys().signing.publicKey)).not.toBe(
      code,
    );
  });
});
