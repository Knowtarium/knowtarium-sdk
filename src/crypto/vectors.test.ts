import { beforeAll, describe, expect, it } from "vitest";

import { decryptAttachment } from "./attachment.js";
import { type BlobContext, encodeBlobContext } from "./blob-context.js";
import { canonicalJson, type JsonObject, type JsonValue } from "./canonical-json.js";
import { openConnectPayload, sealConnectPayloadWithNonce } from "./connect.js";
import { fromHex, toHex, utf8Encode } from "./encoding.js";
import { decryptBytes, encryptBytesWithNonce } from "./envelope.js";
import envelopeVectors from "./envelope-vectors.json" with { type: "json" };
import { isCryptoError } from "./errors.js";
import { ciphertextSha256 } from "./hash.js";
import { derivePasswordSecrets, deriveRecoverySecrets, type PasswordKdfParams } from "./kdf.js";
import {
  boxKeyPairFromPrivateKey,
  connectConfirmationCode,
  signingKeyPairFromSeed,
} from "./keys.js";
import { formatRecoveryCode, parseRecoveryCode } from "./recovery-code.js";
import { signedEventMessage, signEvent, verifyEvent } from "./sign.js";
import {
  canonicalizeEnvelope,
  type SignedEnvelope,
  type SignedEnvelopeFields,
  signedEnvelopeMessage,
  signEnvelope,
  verifyEnvelope,
} from "./signed-envelope.js";
import {
  type SignedWrappedKey,
  unwrapSignedWorkspaceKey,
  verifyKeyGeneration,
  verifyWrappedKey,
} from "./signed-wrap.js";
import { ready } from "./sodium.js";
import vectors from "./vectors.json" with { type: "json" };
import {
  type AccountKeysWrapPurpose,
  unwrapAccountKeys,
  unwrapWorkspaceKeyUnverified,
  wrapAccountKeysWithNonce,
} from "./wrap.js";

// vectors.json and envelope-vectors.json are the cross-implementation contract: other clients
// and knowtarium/protocol must produce and accept the same bytes. Change them only with a new
// format version. Argon2id, Ed25519, X25519 and SHA-256 outputs were cross-checked against
// node:crypto, and the signed envelopes against Web Crypto with an independent canonicalizer.

beforeAll(ready);

const hex = (bytes: Uint8Array) => toHex(bytes);

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isCryptoError(error) ? error.code : String(error);
  }
  return undefined;
}

describe("KDF vectors", () => {
  it.each(vectors.kdf)("derives $name", ({ password, params, loginHash, keyEncryptionKey }) => {
    const secrets = derivePasswordSecrets(password, params as PasswordKdfParams);
    expect(hex(secrets.authHash)).toBe(loginHash);
    expect(hex(secrets.keyEncryptionKey)).toBe(keyEncryptionKey);
  });

  it.each(vectors.recovery)(
    "derives recovery secrets for the $name",
    ({ recoveryKey, recoveryCode, authHash, keyEncryptionKey }) => {
      expect(formatRecoveryCode(fromHex(recoveryKey))).toBe(recoveryCode);
      expect(hex(parseRecoveryCode(recoveryCode))).toBe(recoveryKey);
      const secrets = deriveRecoverySecrets(fromHex(recoveryKey));
      expect(hex(secrets.authHash)).toBe(authHash);
      expect(hex(secrets.keyEncryptionKey)).toBe(keyEncryptionKey);
    },
  );

  it.each(vectors.invalidRecoveryCodes)("rejects a recovery code with $name", ({ code }) => {
    expect(codeOf(() => parseRecoveryCode(code))).toBe("invalid_recovery_code");
  });
});

describe("account key vectors", () => {
  const account = vectors.accountKeys;
  const publicKeys = () => ({
    encryptionPublicKey: fromHex(account.encryptionPublicKey),
    signingPublicKey: fromHex(account.signingPublicKey),
  });

  it("derives the public keys", () => {
    const encryption = boxKeyPairFromPrivateKey(fromHex(account.encryptionPrivateKey));
    const signing = signingKeyPairFromSeed(fromHex(account.signingSeed));
    expect(hex(encryption.publicKey)).toBe(account.encryptionPublicKey);
    expect(hex(signing.publicKey)).toBe(account.signingPublicKey);
  });

  it.each(account.wrapped)("wraps and unwraps $name", (vector) => {
    const purpose = vector.purpose as AccountKeysWrapPurpose;
    const keys = {
      encryption: boxKeyPairFromPrivateKey(fromHex(account.encryptionPrivateKey)),
      signing: signingKeyPairFromSeed(fromHex(account.signingSeed)),
    };
    const kek = fromHex(vector.keyEncryptionKey);
    expect(hex(wrapAccountKeysWithNonce(keys, kek, purpose, fromHex(vector.nonce)))).toBe(
      vector.wrapped,
    );
    const unwrapped = unwrapAccountKeys(fromHex(vector.wrapped), kek, purpose, publicKeys());
    expect(hex(unwrapped.encryption.privateKey)).toBe(account.encryptionPrivateKey);
    expect(hex(unwrapped.signing.privateKey.subarray(0, 32))).toBe(account.signingSeed);
  });

  it("chains: the kdf[0] password and the recovery[0] key open their wrapped copies", () => {
    const [byPassword, byRecovery] = account.wrapped;
    expect(byPassword?.keyEncryptionKey).toBe(vectors.kdf[0]?.keyEncryptionKey);
    expect(byRecovery?.keyEncryptionKey).toBe(vectors.recovery[0]?.keyEncryptionKey);
  });
});

describe("envelope vectors", () => {
  it.each(vectors.envelope)("encrypts $name", (vector) => {
    const key = { generation: vector.generation, key: fromHex(vector.key) };
    const context = vector.context as BlobContext;
    expect(hex(encodeBlobContext(context))).toBe(vector.contextEncoding);
    const blob = encryptBytesWithNonce(
      key,
      fromHex(vector.plaintext),
      context,
      fromHex(vector.nonce),
    );
    expect(hex(blob)).toBe(vector.blob);
    expect(hex(decryptBytes(key, blob, context))).toBe(vector.plaintext);
  });

  it.each(vectors.tamperedEnvelopes)("rejects $name with $error", (vector) => {
    const key = { generation: vector.generation, key: fromHex(vector.key) };
    const run = () => decryptBytes(key, fromHex(vector.blob), vector.context as BlobContext);
    expect(codeOf(run)).toBe(vector.error);
  });

  it.each(vectors.attachments)("decrypts the attachment $name", (vector) => {
    const key = { generation: vector.generation, key: fromHex(vector.key) };
    const data = decryptAttachment(key, vector.chunks.map(fromHex), vector);
    expect(hex(data)).toBe(vector.plaintext);
  });

  it.each(vectors.tamperedAttachments)("rejects an attachment with $name", (vector) => {
    const key = { generation: vector.generation, key: fromHex(vector.key) };
    expect(codeOf(() => decryptAttachment(key, vector.chunks.map(fromHex), vector))).toBe(
      vector.error,
    );
  });
});

describe("workspace key vectors", () => {
  it.each(vectors.workspaceKeyWraps)("unwraps $name", (vector) => {
    const recipient = boxKeyPairFromPrivateKey(fromHex(vector.recipientPrivateKey));
    expect(hex(recipient.publicKey)).toBe(vector.recipientPublicKey);
    const key = unwrapWorkspaceKeyUnverified(
      fromHex(vector.wrapped),
      recipient,
      vector.workspaceId,
    );
    expect(key.generation).toBe(vector.generation);
    expect(hex(key.key)).toBe(vector.key);
  });

  it.each(vectors.signedWrappedKeys)("verifies and unwraps $name", (vector) => {
    const recipient = boxKeyPairFromPrivateKey(fromHex(vector.recipientPrivateKey));
    const signedKey = {
      wrapped: fromHex(vector.wrapped),
      signed: vector.signed as SignedEnvelope,
      signedGeneration: vector.signedGeneration as SignedEnvelope,
    } satisfies SignedWrappedKey;
    const expected = {
      ownerSigningPublicKey: fromHex(vector.ownerSigningPublicKey),
      ownerAccountId: vector.ownerAccountId,
      workspaceId: vector.workspaceId,
    };
    const withRecipient = { ...expected, recipientPublicKey: recipient.publicKey };
    expect(verifyWrappedKey(signedKey.wrapped, signedKey.signed, withRecipient)).toBe(true);
    const generation = { ...expected, generation: vector.generation };
    expect(verifyKeyGeneration(signedKey.signedGeneration, generation)).toBe(true);
    const key = unwrapSignedWorkspaceKey(signedKey, recipient, expected);
    expect(key.generation).toBe(vector.generation);
    expect(hex(key.key)).toBe(vector.key);
  });
});

describe("signed event vectors", () => {
  it.each(vectors.signedEvents)("signs the $name event", (vector) => {
    const signer = signingKeyPairFromSeed(fromHex(vector.signingSeed));
    const event = vector.event as JsonObject;
    expect(hex(signer.publicKey)).toBe(vector.publicKey);
    expect(hex(signedEventMessage(event))).toBe(vector.message);
    const signed = signEvent(event, signer);
    expect(signed.signature).toBe(vector.signature);
    expect(verifyEvent(signed, fromHex(vector.publicKey))).toBe(true);
  });
});

describe("connect vectors", () => {
  it.each(vectors.confirmationCodes)("gives the code for $name", (vector) => {
    const code = connectConfirmationCode(
      fromHex(vector.cliPublicKey),
      fromHex(vector.ownerSigningPublicKey),
    );
    expect(code).toBe(vector.code);
  });

  it.each(vectors.connectPayloads)("seals and opens $name", (vector) => {
    const keyPair = boxKeyPairFromPrivateKey(fromHex(vector.cliPrivateKey));
    const secret = fromHex(vector.secret);
    const payload = {
      token: vector.payload.token,
      ownerSigningPublicKey: fromHex(vector.payload.ownerSigningPublicKey),
      signedWrappedKey: {
        wrapped: fromHex(vector.payload.wrapped),
        signed: vector.payload.signed as SignedEnvelope,
        signedGeneration: vector.payload.signedGeneration as SignedEnvelope,
      },
    };
    const sealed = sealConnectPayloadWithNonce(
      payload,
      { secret, cliPublicKey: keyPair.publicKey },
      fromHex(vector.nonce),
    );
    expect(hex(sealed)).toBe(vector.sealed);
    const opened = openConnectPayload(fromHex(vector.sealed), { secret, keyPair });
    expect(opened.token).toBe(vector.payload.token);
    expect(opened.ownerAccountId).toBe(vector.expected.ownerAccountId);
    expect(opened.workspaceId).toBe(vector.expected.workspaceId);
    expect(opened.workspaceKey.generation).toBe(vector.expected.generation);
    expect(hex(opened.workspaceKey.key)).toBe(vector.expected.key);
    expect(opened.confirmationCode).toBe(vector.expected.confirmationCode);
  });

  it.each(vectors.tamperedConnectPayloads)("rejects a payload with $name", (vector) => {
    const keyPair = boxKeyPairFromPrivateKey(fromHex(vector.cliPrivateKey));
    const run = () =>
      openConnectPayload(fromHex(vector.sealed), { secret: fromHex(vector.secret), keyPair });
    expect(codeOf(run)).toBe(vector.error);
  });
});

describe("envelope-vectors.json (shared with knowtarium/protocol)", () => {
  it.each(envelopeVectors.canonicalJson)("encodes $name", ({ value, canonical }) => {
    expect(canonicalJson(value as JsonValue)).toBe(canonical);
  });

  it.each(envelopeVectors.nonCanonicalJson)("refuses $name", ({ value }) => {
    expect(codeOf(() => canonicalJson(value as JsonValue))).toBe("non_canonical_json");
  });

  it.each(envelopeVectors.sha256)("hashes $name", ({ input, sha256 }) => {
    expect(ciphertextSha256(fromHex(input))).toBe(sha256);
  });

  it.each(envelopeVectors.signedEnvelopes)("signs $name", (vector) => {
    const signer = signingKeyPairFromSeed(fromHex(vector.signingSeed));
    const fields = vector.fields as SignedEnvelopeFields;
    expect(canonicalizeEnvelope(fields)).toBe(vector.canonical);
    const message = signedEnvelopeMessage(fields);
    expect(hex(message)).toBe(vector.message);
    expect(message).toEqual(utf8Encode(envelopeVectors.messagePrefix + vector.canonical));
    const signed = signEnvelope(fields, signer);
    expect(signed.signature).toBe(vector.signature);
    expect(verifyEnvelope(signed, fromHex(vector.publicKey))).toBe(true);
  });

  it.each(envelopeVectors.invalidEnvelopes)("refuses an envelope with $name", ({ fields }) => {
    expect(codeOf(() => canonicalizeEnvelope(fields as SignedEnvelopeFields))).toBe(
      "invalid_input",
    );
  });
});
