import { beforeAll, describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url, toHex } from "./encoding.js";
import {
  assertKdfParams,
  createKdfParams,
  DEFAULT_KDF_MEM_LIMIT,
  DEFAULT_KDF_OPS_LIMIT,
  derivePasswordSecrets,
  deriveRecoverySecrets,
  type PasswordKdfParams,
} from "./kdf.js";
import { ready } from "./sodium.js";

beforeAll(ready);

const params = createKdfParams;

describe("KDF params", () => {
  it("creates the documented defaults with a random 16-byte salt", () => {
    const a = params();
    const b = params();
    expect(a).toMatchObject({ algorithm: "argon2id13", opsLimit: 3, memLimit: 64 * 1024 * 1024 });
    expect(fromBase64Url(a.salt)).toHaveLength(16);
    expect(a.salt).not.toBe(b.salt);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it("accepts stronger params, up to the ceiling", () => {
    expect(() => {
      assertKdfParams({ ...params(), opsLimit: 10, memLimit: 256 * 1024 * 1024 });
    }).not.toThrow();
  });

  it.each([
    ["a weaker ops limit (downgrade)", { opsLimit: DEFAULT_KDF_OPS_LIMIT - 1 }],
    ["a smaller memory limit (downgrade)", { memLimit: DEFAULT_KDF_MEM_LIMIT - 1024 }],
    ["an absurd ops limit", { opsLimit: 1000 }],
    ["an absurd memory limit", { memLimit: 8 * 1024 * 1024 * 1024 }],
    ["a fractional ops limit", { opsLimit: 3.5 }],
    ["a string ops limit", { opsLimit: "3" }],
    ["another algorithm", { algorithm: "argon2i13" }],
    ["a short salt", { salt: toBase64Url(new Uint8Array(8)) }],
    ["a salt that isn't base64url", { salt: "not base64!" }],
    ["a missing salt", { salt: undefined }],
  ])("refuses %s", (_, change) => {
    expect(() => {
      assertKdfParams({ ...params(), ...change });
    }).toThrow(expect.objectContaining({ code: "invalid_kdf_params" }));
  });

  it.each([null, undefined, "params", 3])("refuses %j", (value) => {
    expect(() => {
      assertKdfParams(value);
    }).toThrow(expect.objectContaining({ code: "invalid_kdf_params" }));
  });
});

describe("derivePasswordSecrets", () => {
  let fixed: PasswordKdfParams;
  beforeAll(() => {
    fixed = params();
  });

  it("is deterministic and domain-separates the login hash from the key-encryption key", () => {
    const a = derivePasswordSecrets("hunter2 hunter2", fixed);
    const b = derivePasswordSecrets("hunter2 hunter2", fixed);
    expect(a).toEqual(b);
    expect(a.authHash).toHaveLength(32);
    expect(a.keyEncryptionKey).toHaveLength(32);
    expect(toHex(a.authHash)).not.toBe(toHex(a.keyEncryptionKey));
  });

  it("depends on the password and on the salt", () => {
    const a = derivePasswordSecrets("hunter2 hunter2", fixed);
    expect(toHex(derivePasswordSecrets("hunter2 hunter3", fixed).authHash)).not.toBe(
      toHex(a.authHash),
    );
    expect(toHex(derivePasswordSecrets("hunter2 hunter2", params()).authHash)).not.toBe(
      toHex(a.authHash),
    );
  });

  it("refuses an empty password and bad params", () => {
    expect(() => derivePasswordSecrets("", fixed)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => derivePasswordSecrets("pw", { ...fixed, opsLimit: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_kdf_params" }),
    );
  });

  it("keeps password and recovery derivations apart", () => {
    const key = new Uint8Array(32).fill(1);
    const recovery = deriveRecoverySecrets(key);
    expect(toHex(recovery.authHash)).not.toBe(toHex(recovery.keyEncryptionKey));
    expect(() => deriveRecoverySecrets(new Uint8Array(31))).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});
