// `knowtarium/crypto`: the one place Knowtarium clients derive, wrap and use keys (libsodium).
// Await `ready()` once, then everything is synchronous. The model and formats are in DEVELOPING.md.

export { ready, wipe } from "./sodium.js";
export { CryptoError, type CryptoErrorCode, isCryptoError } from "./errors.js";
export { fromBase64Url, toBase64Url } from "./encoding.js";

export {
  assertKdfParams,
  createKdfParams,
  DEFAULT_KDF_MEM_LIMIT,
  DEFAULT_KDF_OPS_LIMIT,
  type DerivedSecrets,
  derivePasswordSecrets,
  deriveRecoverySecrets,
  type PasswordKdfParams,
} from "./kdf.js";
export { formatRecoveryCode, generateRecoveryKey, parseRecoveryCode } from "./recovery-code.js";
export {
  type AccountKeys,
  type AccountPublicKeys,
  accountPublicKeys,
  type BoxKeyPair,
  boxKeyPairFromPrivateKey,
  connectConfirmationCode,
  createAccountKeys,
  createAgentKeyPair,
  createAgentSigningKeyPair,
  type SigningKeyPair,
} from "./keys.js";
export {
  changePassword,
  createAccount,
  createRecovery,
  type NewAccount,
  type PasswordMaterial,
  type RecoveryMaterial,
} from "./account.js";
export { type AccountKeysWrapPurpose, unwrapAccountKeys, wrapAccountKeys } from "./wrap.js";

export {
  createKeyring,
  createWorkspaceKey,
  rotateWorkspaceKey,
  type WorkspaceKey,
  type WorkspaceKeyring,
} from "./workspace-keys.js";
export {
  KEY_GENERATION_ENVELOPE_TYPE,
  type KeyGenerationExpectation,
  signKeyGeneration,
  type SignedWrappedKey,
  signTokenRevocation,
  TOKEN_REVOKED_ENVELOPE_TYPE,
  unwrapSignedWorkspaceKey,
  verifyKeyGeneration,
  verifyTokenRevocation,
  verifyWrappedKey,
  wrapAndSignWorkspaceKey,
  WRAPPED_KEY_ENVELOPE_TYPE,
  type WrappedKeyExpectation,
} from "./signed-wrap.js";

export { BLOB_KINDS, type BlobContext, type BlobKind } from "./blob-context.js";
export {
  decryptBytes,
  decryptJson,
  decryptText,
  encryptBytes,
  encryptJson,
  encryptText,
  ENVELOPE_FORMAT_VERSION,
  type EnvelopeHeader,
  readEnvelopeHeader,
  type WorkspaceKeys,
} from "./envelope.js";
export {
  type AttachmentContext,
  decryptAttachment,
  DEFAULT_CHUNK_BYTES,
  encryptAttachment,
} from "./attachment.js";

export { canonicalJson, type JsonObject, type JsonValue } from "./canonical-json.js";
export { type SignedEvent, signEvent, verifyEvent } from "./sign.js";
export {
  canonicalizeEnvelope,
  SIGNED_ENVELOPE_OPTIONAL,
  SIGNED_ENVELOPE_TOGETHER,
  SIGNED_ENVELOPE_TYPES,
  type SignedEnvelope,
  type SignedEnvelopeFields,
  type SignedEnvelopeType,
  signEnvelope,
  verifyEnvelope,
  verifyEnvelopeFor,
  WRAPPED_KEY_ACCOUNT_HOLDER,
} from "./signed-envelope.js";
export {
  ciphertextSha256,
  KEY_COMMITMENT_TAG,
  RECIPIENTS_HASH_TAG,
  recipientsHash,
  sha256,
  workspaceKeyCommitment,
} from "./hash.js";

export {
  type ConnectPayload,
  createConnectSecret,
  type OpenedConnectPayload,
  openConnectPayload,
  sealConnectPayload,
} from "./connect.js";
