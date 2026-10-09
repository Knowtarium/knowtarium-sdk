import {
  assertKdfParams,
  derivePasswordSecrets,
  fromBase64Url,
  isCryptoError,
  unwrapAccountKeys,
  wipe,
} from "../../crypto/index.js";
import type { AccountKeys, AccountPublicKeys } from "../../protocol/index.js";
import { VaultError } from "../errors/index.js";

/**
 * Proves account key material is the person's: derives the key-encryption key from the password
 * with the material's KDF parameters (checked against crypto's floor), unwraps `wrappedByMaster`
 * and requires the unwrapped keys to match the material's public keys. Returns those public keys;
 * throws `untrusted_signature` when the password doesn't open them. Wipes every secret it made.
 */
export function proveAccountKeys(password: string, material: AccountKeys): AccountPublicKeys {
  const params = {
    algorithm: material.kdf.algorithm,
    opsLimit: material.kdf.opsLimit,
    memLimit: material.kdf.memLimitBytes,
    salt: material.kdf.salt,
  };
  assertKdfParams(params);
  const secrets = derivePasswordSecrets(password, params);
  try {
    const keys = unwrapAccountKeys(
      fromBase64Url(material.wrappedByMaster.encSecretKeys),
      secrets.keyEncryptionKey,
      "password",
      {
        encryptionPublicKey: fromBase64Url(material.publicKeys.box),
        signingPublicKey: fromBase64Url(material.publicKeys.sign),
      },
    );
    wipe(keys.encryption.privateKey, keys.signing.privateKey);
    return material.publicKeys;
  } catch (error) {
    if (isCryptoError(error)) {
      throw new VaultError("untrusted_signature", "the password doesn't open the new account keys");
    }
    throw error;
  } finally {
    wipe(secrets.keyEncryptionKey, secrets.authHash);
  }
}
