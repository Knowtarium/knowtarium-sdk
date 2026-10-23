import { canonicalJson, type JsonObject } from "./canonical-json.js";
import { fromBase64Url, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";

// The fields of a signed envelope and the exact bytes its signature covers, without libsodium:
// signed-envelope.ts signs and verifies them, and knowtarium/clip (the web clipper's light entry,
// on the standard libsodium build) checks the owner's inbox_key and extension_key with the same
// rules. See signed-envelope.ts for the format.

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
  | "policyRevision"
  | "publicKey"
  | "extensionId"
  | "scopeSha256"
  | "prevScopeSha256"
  | "scopeRevision"
  | "fromParentId";

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
  /**
   * The owner signs a workspace's inbox key (the web clipper): the X25519 `publicKey` derived from
   * key `generation` (`deriveInboxKeyPair`) and the inbox `folderId`, as its `revision` (the API
   * stores revision 1 or more, each new one the last + 1).
   */
  inbox_key: ["revision", "generation", "publicKey", "folderId"],
  /** The owner vouches for a paired extension's Ed25519 key (`signPublicKey`, base64url). */
  extension_key: ["extensionId", "signPublicKey"],
  /**
   * The owner signs an agent token's scope (protocol 3): its `revision` (1 at connect, then +1 per
   * change; the API stores 1 or more) and `scopeSha256` (`agentScopeSha256` in
   * knowtarium/protocol of the access, folders and permissions).
   */
  agent_scope: ["tokenId", "revision", "scopeSha256", "prevScopeSha256"],
  /**
   * An agent's note delete, signed with the AGENT's key like `agent_edited`: the delete marker's
   * `version` (base + 1) of the note in `folderId`, the agent policy `revision` and
   * `policySha256` it checked, and the `scopeRevision` it acted under.
   */
  agent_deleted: [
    "tokenId",
    "noteId",
    "version",
    "folderId",
    "revision",
    "policySha256",
    "scopeRevision",
  ],
  /** An agent creates or revives a folder; `ciphertextSha256` is its encrypted name's hash. */
  agent_folder_created: [
    "tokenId",
    "folderId",
    "ciphertextSha256",
    "revision",
    "policySha256",
    "scopeRevision",
  ],
  /** An agent renames a folder; `ciphertextSha256` is the new encrypted name's hash. */
  agent_folder_renamed: [
    "tokenId",
    "folderId",
    "ciphertextSha256",
    "revision",
    "policySha256",
    "scopeRevision",
  ],
  /**
   * An agent moves a folder (`parentId`, optional, is the destination; `fromParentId`, optional,
   * the parent it leaves).
   */
  agent_folder_moved: ["tokenId", "folderId", "revision", "policySha256", "scopeRevision"],
  /** An agent deletes an empty folder. */
  agent_folder_deleted: ["tokenId", "folderId", "revision", "policySha256", "scopeRevision"],
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
  /** The parent folder; absent means the top level. */
  agent_folder_created: ["parentId"],
  /** The folder's parent; absent means the top level. */
  agent_folder_renamed: ["parentId"],
  /** The destination and the parent it leaves; absent means the top level. */
  agent_folder_moved: ["parentId", "fromParentId"],
  /** The folder's parent; absent means the top level. */
  agent_folder_deleted: ["parentId"],
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
  /**
   * For "folder_created", "folder_moved", "agent_folder_created" and "agent_folder_moved": the
   * (destination) parent; absent is the root.
   */
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
   * A comment's revision, the agent policy's for "agent_policy", "agent_edited" and the agent
   * actions of protocol 3, or the scope's for "agent_scope" (0 or more).
   */
  readonly revision?: number;
  /** For "wrapped_key", "key_generation" and "inbox_key": a key generation (1 or more). */
  readonly generation?: number;
  /** `ciphertextSha256()` of the uploaded bytes the action stores or approves. */
  readonly ciphertextSha256?: string;
  /** For "key_generation": `recipientsHash()` of the generation's recipient public keys. */
  readonly recipientsHash?: string;
  /** For "key_generation": `workspaceKeyCommitment()` of the generation's workspace key. */
  readonly keyCommitment?: string;
  /** For "token_revoked", "agent_key", "agent_scope" and the agent-signed types: the token's id. */
  readonly tokenId?: string;
  /**
   * For "wrapped_key": who holds the copy, `"account"` (`WRAPPED_KEY_ACCOUNT_HOLDER`) for the
   * owner's own copy or the agent token id (`tok_...`) for an agent's.
   */
  readonly holder?: string;
  /** For "check_applied": the check record (`chk_...`) the new version applies. */
  readonly checkId?: string;
  /**
   * For "agent_policy" and the agent-signed types: `agentPolicySha256` of the policy's rules,
   * lowercase hex.
   */
  readonly policySha256?: string;
  /** For "agent_key" and "extension_key": an Ed25519 public key, base64url (32 bytes). */
  readonly signPublicKey?: string;
  /** For "agent_key": the agent policy revision when the agent connected (0 or more). */
  readonly policyRevision?: number;
  /** For "inbox_key": the inbox X25519 public key, base64url (32 bytes). */
  readonly publicKey?: string;
  /** For "extension_key": the paired extension's id (`ext_...`). */
  readonly extensionId?: string;
  /** For "agent_scope": `agentScopeSha256` of the token's scope, lowercase hex. */
  readonly scopeSha256?: string;
  /** For "agent_scope": the previous revision's `scopeSha256` (64 zeros at revision 1). */
  readonly prevScopeSha256?: string;
  /** For "agent_folder_moved": the parent the folder leaves; absent is the top level. */
  readonly fromParentId?: string;
  /** For an agent's protocol 3 actions: the scope revision it acted under (0 or more). */
  readonly scopeRevision?: number;
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
/** Bytes in an Ed25519 signature. */
export const SIGNATURE_BYTES = 64;
const INTEGER_MINIMUMS: Partial<Record<string, number>> = {
  version: 0,
  revision: 0,
  generation: 1,
  policyRevision: 0,
  scopeRevision: 0,
};
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOKEN_ID = /^tok_[0-9a-hjkmnp-tv-z]{26}$/;
const EXTENSION_ID = /^ext_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
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

/** Why `fields` isn't a valid envelope, or undefined when it is. */
export function envelopeProblem(fields: unknown): string | undefined {
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
    key === "policySha256" ||
    key === "scopeSha256" ||
    key === "prevScopeSha256"
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
  if (key === "signPublicKey" || key === "publicKey") {
    return isBase64UrlKey(value) ? undefined : `${key} must be 32 bytes, base64url`;
  }
  if (key === "extensionId") {
    return typeof value === "string" && EXTENSION_ID.test(value)
      ? undefined
      : "extensionId must be an extension id";
  }
  if (key === "createdAt") {
    return isIsoMilliseconds(value) ? undefined : "createdAt must be UTC with milliseconds";
  }
  return typeof value === "string" && value.length > 0 ? undefined : `${key} must be non-empty`;
}

/** Whether `value` is a 32-byte key as unpadded base64url (43 characters). */
export function isBase64UrlKey(value: unknown): boolean {
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
