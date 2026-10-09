import { canonicalJson, type JsonObject } from "./canonical-json.js";
import { fromBase64Url, toBase64Url, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";
import type { SigningKeyPair } from "./keys.js";
import { sodium } from "./sodium.js";
import { assertBytes } from "./validate.js";

// Signed envelopes: the server-verifiable signature on a person's action, or, for "agent_edited",
// on an agent's direct write under the agent's own key (which the owner vouched for with
// "agent_key"). Where a signed event (sign.ts) travels inside encryption, a signed envelope covers
// only what the server may see (ids, versions, the SHA-256 of the ciphertext, a time), so the
// sync API can check with the signer's public key (Web Crypto Ed25519, no libsodium) that an
// approval, edit or comment really comes from the person (or the agent), and bind it to the exact
// ciphertext it stores.
//
// The signed message is the UTF-8 bytes of
//
//   "knowtarium-envelope-v1\n" + canonical JSON of the envelope fields
//
// The fields hold only strings and integers, so their canonical JSON is simply: keys sorted by
// UTF-16 code units, no whitespace, values as JSON.stringify writes them. Every type requires
// type, accountId, workspaceId and createdAt plus its own fields (SIGNED_ENVELOPE_TYPES), may have
// the few optional fields SIGNED_ENVELOPE_OPTIONAL lists, and nothing else, so the signer and the
// server (which rebuilds the envelope from the request) always agree on what was signed.
// envelope-vectors.json pins all of this for reimplementations and for knowtarium/protocol.

/** The signed envelope format this SDK writes and verifies. */
export const SIGNED_ENVELOPE_VERSION = 1;

/** Fields every signed envelope has. */
const BASE_FIELDS = ["type", "accountId", "workspaceId", "createdAt"] as const;

/** Every other field a signed envelope may have. */
type OptionalField =
  | "noteId"
  | "folderId"
  | "parentId"
  | "pendingId"
  | "commentId"
  | "eventId"
  | "recipient"
  | "version"
  | "revision"
  | "generation"
  | "ciphertextSha256"
  | "recipientsHash"
  | "keyCommitment"
  | "tokenId"
  | "holder"
  | "checkId"
  | "policySha256"
  | "signPublicKey"
  | "policyRevision";

/**
 * The signed envelope types and the fields each requires on top of type, accountId, workspaceId
 * and createdAt. `knowtarium/protocol` (signatures.ts) has the same table: the server rebuilds each
 * envelope from the request, so a type allows only these fields plus its SIGNED_ENVELOPE_OPTIONAL
 * ones.
 */
export const SIGNED_ENVELOPE_TYPES = {
  edited: ["noteId", "version", "folderId", "ciphertextSha256"],
  deleted: ["noteId", "version"],
  /** `folderId` is the folder the approved note sits in, as the version is stored. */
  approved: ["noteId", "pendingId", "version", "folderId", "ciphertextSha256"],
  /** `noteId` is the note the pending change proposed a version of. */
  rejected: ["noteId", "pendingId"],
  commented: ["commentId", "revision", "ciphertextSha256"],
  recorded: ["eventId", "ciphertextSha256"],
  /** `holder` is who the copy is for: `"account"` (the owner's own copy) or the agent token id. */
  wrapped_key: ["recipient", "holder", "generation", "ciphertextSha256"],
  /**
   * `recipientsHash` is `recipientsHash()` of every recipient public key of the generation, and
   * `keyCommitment` is `workspaceKeyCommitment()` of the generation's key.
   */
  key_generation: ["generation", "recipientsHash", "keyCommitment"],
  /** The owner revoked an agent token: its id and the public key its copies were sealed for. */
  token_revoked: ["recipient", "tokenId"],
  /**
   * A person's session wrote an agent's passing check into the note (its `verified` entry) as a
   * new version: like `edited`, plus the check record it applied. Never a person's confirmation.
   */
  check_applied: ["noteId", "version", "folderId", "ciphertextSha256", "checkId"],
  /** `ciphertextSha256` is the hash of the encrypted folder name. */
  folder_created: ["folderId", "ciphertextSha256"],
  folder_moved: ["folderId"],
  /**
   * The owner set the workspace's agent policy (protocol 2): `revision` is the policy's new
   * revision, `policySha256` the hash of its rules (`agentPolicySha256` in knowtarium/protocol).
   */
  agent_policy: ["revision", "policySha256"],
  /**
   * The owner vouches for an agent token's Ed25519 signing key (`signPublicKey`, base64url), and
   * for `policyRevision`, the agent policy revision when it connected: the agent's floor.
   */
  agent_key: ["tokenId", "signPublicKey", "policyRevision"],
  /**
   * An agent's direct write, signed with the AGENT's key (the one its `agent_key` names), never
   * the account's: like `edited` plus the token id, the agent policy `revision` it checked and
   * that revision's `policySha256`. `accountId` is the workspace owner's account.
   */
  agent_edited: [
    "tokenId",
    "noteId",
    "version",
    "folderId",
    "ciphertextSha256",
    "revision",
    "policySha256",
  ],
} as const satisfies Record<string, readonly OptionalField[]>;

/**
 * The fields a type may have but doesn't require; when present they are signed like any other.
 * No other type has any.
 */
export const SIGNED_ENVELOPE_OPTIONAL = {
  /** The comment a rejection leaves, if any, with the hash of its ciphertext (both or neither). */
  rejected: ["commentId", "ciphertextSha256"],
  /** The note the comment is on, when it is on a note. */
  commented: ["noteId"],
  /** The note the event is about, when it is about a note. */
  recorded: ["noteId"],
  /** The parent folder; absent means the workspace root. */
  folder_created: ["parentId"],
  /** The destination parent folder; absent means the workspace root. */
  folder_moved: ["parentId"],
} as const satisfies Partial<Record<keyof typeof SIGNED_ENVELOPE_TYPES, readonly OptionalField[]>>;

/** Optional fields that come together: each group is all present or all absent. */
export const SIGNED_ENVELOPE_TOGETHER = {
  rejected: [["commentId", "ciphertextSha256"]],
} as const satisfies Partial<
  Record<keyof typeof SIGNED_ENVELOPE_TYPES, readonly (readonly OptionalField[])[]>
>;

/** One signed envelope type. */
export type SignedEnvelopeType = keyof typeof SIGNED_ENVELOPE_TYPES;

/** What a signed envelope covers. Everything here is visible to the server. */
export interface SignedEnvelopeFields {
  /** The action; it decides which fields are required and allowed (see SIGNED_ENVELOPE_TYPES). */
  readonly type: SignedEnvelopeType;
  /**
   * The signing person's account id; for "agent_edited", the workspace owner's account (the
   * agent signs, `tokenId` names it).
   */
  readonly accountId: string;
  readonly workspaceId: string;
  readonly noteId?: string;
  readonly folderId?: string;
  /** For "folder_created" and "folder_moved": the (destination) parent; absent is the root. */
  readonly parentId?: string;
  /** The pending change an approval or rejection decides. */
  readonly pendingId?: string;
  readonly commentId?: string;
  readonly eventId?: string;
  /** For "wrapped_key" and "token_revoked": the recipient's X25519 public key, base64url. */
  readonly recipient?: string;
  /** The note version the action creates or refers to (0 or more). */
  readonly version?: number;
  /**
   * A comment's revision, or the agent policy's for "agent_policy" and "agent_edited" (0 or
   * more).
   */
  readonly revision?: number;
  /** For "wrapped_key" and "key_generation": a workspace key generation (1 or more). */
  readonly generation?: number;
  /** `ciphertextSha256()` of the uploaded bytes the action stores or approves. */
  readonly ciphertextSha256?: string;
  /** For "key_generation": `recipientsHash()` of the generation's recipient public keys. */
  readonly recipientsHash?: string;
  /** For "key_generation": `workspaceKeyCommitment()` of the generation's workspace key. */
  readonly keyCommitment?: string;
  /** For "token_revoked", "agent_key" and "agent_edited": the agent token's id. */
  readonly tokenId?: string;
  /**
   * For "wrapped_key": who holds the copy, `"account"` (`WRAPPED_KEY_ACCOUNT_HOLDER`) for the
   * owner's own copy or the agent token id (`tok_...`) for an agent's.
   */
  readonly holder?: string;
  /** For "check_applied": the check record (`chk_...`) the new version applies. */
  readonly checkId?: string;
  /** For "agent_policy": `agentPolicySha256` of the policy's rules, lowercase hex. */
  readonly policySha256?: string;
  /** For "agent_key": the agent's Ed25519 public key, base64url (32 bytes). */
  readonly signPublicKey?: string;
  /** For "agent_key": the agent policy revision when the agent connected (0 or more). */
  readonly policyRevision?: number;
  /** When it was signed, as `Date.prototype.toISOString()` writes it (UTC, milliseconds). */
  readonly createdAt: string;
}

/** Envelope fields with their signature, sent to the server next to the ciphertext. */
export interface SignedEnvelope {
  readonly version: typeof SIGNED_ENVELOPE_VERSION;
  readonly envelope: SignedEnvelopeFields;
  /** Ed25519 signature over the signed message, base64url (64 bytes). */
  readonly signature: string;
}

const DOMAIN = "knowtarium-envelope-v1\n";
const SIGNATURE_BYTES = 64;
const INTEGER_MINIMUMS: Partial<Record<string, number>> = {
  version: 0,
  revision: 0,
  generation: 1,
  policyRevision: 0,
};
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOKEN_ID = /^tok_[0-9a-hjkmnp-tv-z]{26}$/;
const PUBLIC_KEY_BYTES = 32;

/** The `holder` of the owner's own copy of a workspace key (an agent's copy names its token id). */
export const WRAPPED_KEY_ACCOUNT_HOLDER = "account";

/**
 * The canonical JSON text of envelope fields, the part of the signed message a server rebuilds.
 * Throws `invalid_input` for an unknown type, a missing required field, an unknown field or a
 * malformed value.
 */
export function canonicalizeEnvelope(fields: SignedEnvelopeFields): string {
  const problem = envelopeProblem(fields);
  if (problem !== undefined) throw new CryptoError("invalid_input", `envelope: ${problem}`);
  return canonicalJson(fields as unknown as JsonObject);
}

/** The exact bytes a signed envelope's signature covers. */
export function signedEnvelopeMessage(fields: SignedEnvelopeFields): Uint8Array {
  return utf8Encode(DOMAIN + canonicalizeEnvelope(fields));
}

/** Signs envelope fields with the account signing key. */
export function signEnvelope(
  fields: SignedEnvelopeFields,
  signingKey: SigningKeyPair,
): SignedEnvelope {
  assertBytes(signingKey.privateKey, 64, "Ed25519 private key");
  const message = signedEnvelopeMessage(fields);
  const signature = sodium().crypto_sign_detached(message, signingKey.privateKey);
  return { version: SIGNED_ENVELOPE_VERSION, envelope: fields, signature: toBase64Url(signature) };
}

/**
 * Whether `signed` carries a valid signature by `signerPublicKey` (the signing key on record for
 * `envelope.accountId`). Returns false for malformed input; throws only for a malformed public key.
 * Checking that `ciphertextSha256` matches the uploaded bytes is up to the caller.
 */
export function verifyEnvelope(signed: SignedEnvelope, signerPublicKey: Uint8Array): boolean {
  const lib = sodium();
  assertBytes(signerPublicKey, 32, "Ed25519 public key");
  try {
    const { version, signature: text } = signed as { version: unknown; signature: unknown };
    if (version !== SIGNED_ENVELOPE_VERSION || typeof text !== "string") return false;
    const signature = fromBase64Url(text);
    if (signature.length !== SIGNATURE_BYTES) return false;
    return lib.crypto_sign_verify_detached(
      signature,
      signedEnvelopeMessage(signed.envelope),
      signerPublicKey,
    );
  } catch {
    return false;
  }
}

/**
 * `verifyEnvelope`, plus every field in `expected` must equal the signed one: pass what the
 * caller knows independently (type, account, workspace, note, version, hash of the bytes it
 * received, ...). The type is required, so a signature for one action never passes as another.
 */
export function verifyEnvelopeFor(
  signed: SignedEnvelope,
  signerPublicKey: Uint8Array,
  expected: Partial<SignedEnvelopeFields> & { readonly type: SignedEnvelopeType },
): boolean {
  if (!verifyEnvelope(signed, signerPublicKey)) return false;
  const fields = signed.envelope as unknown as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => fields[key] === value);
}

/** Why `fields` isn't a valid envelope, or undefined when it is. */
function envelopeProblem(fields: unknown): string | undefined {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return "not an object";
  }
  const record = fields as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string" || !Object.hasOwn(SIGNED_ENVELOPE_TYPES, type)) {
    return "unknown type";
  }
  const required: readonly string[] = [
    ...BASE_FIELDS,
    ...SIGNED_ENVELOPE_TYPES[type as SignedEnvelopeType],
  ];
  const missing = required.find((key) => !(key in record));
  if (missing !== undefined) return `a ${type} envelope requires ${missing}`;
  const optional: readonly string[] =
    (SIGNED_ENVELOPE_OPTIONAL as Partial<Record<string, readonly string[]>>)[type] ?? [];
  for (const [key, value] of Object.entries(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      return `a ${type} envelope has no field ${key}`;
    }
    const problem = fieldProblem(key, value);
    if (problem !== undefined) return problem;
  }
  const groups: readonly (readonly string[])[] =
    (SIGNED_ENVELOPE_TOGETHER as Partial<Record<string, readonly (readonly string[])[]>>)[type] ??
    [];
  for (const group of groups) {
    const present = group.filter((key) => key in record).length;
    if (present !== 0 && present !== group.length) {
      return `a ${type} envelope has ${group.join(" and ")} together or not at all`;
    }
  }
  return undefined;
}

function fieldProblem(key: string, value: unknown): string | undefined {
  const minimum = INTEGER_MINIMUMS[key];
  if (minimum !== undefined) {
    const ok = typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
    return ok ? undefined : `${key} must be an integer of at least ${String(minimum)}`;
  }
  if (
    key === "ciphertextSha256" ||
    key === "recipientsHash" ||
    key === "keyCommitment" ||
    key === "policySha256"
  ) {
    return typeof value === "string" && SHA256_HEX.test(value)
      ? undefined
      : `${key} must be 64 lowercase hex characters`;
  }
  if (key === "holder") {
    return value === WRAPPED_KEY_ACCOUNT_HOLDER ||
      (typeof value === "string" && TOKEN_ID.test(value))
      ? undefined
      : 'holder must be "account" or a token id';
  }
  if (key === "signPublicKey") {
    return isBase64UrlKey(value) ? undefined : "signPublicKey must be 32 bytes, base64url";
  }
  if (key === "createdAt") {
    return isIsoMilliseconds(value) ? undefined : "createdAt must be UTC with milliseconds";
  }
  return typeof value === "string" && value.length > 0 ? undefined : `${key} must be non-empty`;
}

/** Whether `value` is a 32-byte key as unpadded base64url (43 characters). */
function isBase64UrlKey(value: unknown): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return fromBase64Url(value).length === PUBLIC_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Whether `value` is a real instant written exactly as `Date.prototype.toISOString()` does. */
function isIsoMilliseconds(value: unknown): boolean {
  if (typeof value !== "string" || !ISO_MILLISECONDS.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}
