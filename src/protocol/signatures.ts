import { z } from "zod";

import { canonicalJson } from "./canonical.js";
import { PublicKey, Signature } from "./ciphertext.js";
import { SIGNATURE_HEADER, SIGNED_AT_HEADER, headerKey } from "./headers.js";
import {
  AccountId,
  CheckId,
  CommentId,
  EventId,
  FolderId,
  NoteId,
  PendingId,
  TokenId,
  WorkspaceId,
} from "./ids.js";
import {
  Base64Url,
  base64UrlLength,
  KeyGeneration,
  SignedTimestamp,
  Version,
} from "./primitives.js";

/*
 * A person's actions are signed with the account's Ed25519 signing key, whose public half the
 * server stores at sign-up. The signature covers a canonical envelope made only of things the
 * server can see, so the server verifies it and refuses bad ones; clients verify it too (a wrapped
 * key before unwrapping it, so the server can't plant a key it knows). Private details stay in
 * the ciphertext.
 *
 * A request carries only `signedAt` and `signature` (headers on raw routes, body fields on JSON
 * routes). The server builds the envelope from the request and its own records and verifies
 * against that. A person (session) signs everything except one route: the server refuses signing
 * fields from an agent (Bearer) caller, except on the route marked `agentSigns`
 * (`writeNoteAsAgent`), where the agent signs `agent_edited` with its own Ed25519 key.
 *
 * Agent keys (protocol 2): at connect time the CLI makes an Ed25519 key pair next to its X25519
 * one and puts the public half in the fragment (`signPublicKey`). The owner vouches for it with an
 * `agent_key` envelope naming the token id and that key, so neither the server nor another agent
 * can swap it, and the agent policy revision current then (`policyRevision`), below which the
 * agent never accepts a policy (agent-policy.ts). An `agent_edited` signature counts only under a key some verified `agent_key`
 * vouches for, for the same token id; `accountId` in `agent_edited` is the workspace owner's
 * account (the token's account), never the agent, so the common fields stay the same for every
 * type. Tokens made before protocol 2 have no signing key and can only propose
 * (`agent_key_required`).
 *
 * | Route                     | type             | Envelope fields besides the common ones        |
 * |---------------------------|------------------|------------------------------------------------|
 * | writeNote                 | `edited`         | noteId, folderId, version = base + 1, body hash|
 * | deleteNote                | `deleted`        | noteId, version = base + 1                     |
 * | approvePending            | `approved`       | noteId, pendingId, folderId (the pending       |
 * |                           |                  | change's), version = base + 1, body hash       |
 * | rejectPending             | `rejected`       | noteId, pendingId, commentId, the comment's    |
 * |                           |                  | hash (the two together; this API always sends  |
 * |                           |                  | both)                                          |
 * | addComment, updateComment | `commented`      | noteId, commentId, revision (1, or base + 1),  |
 * |                           |                  | ciphertext hash                                |
 * | addEvent                  | `recorded`       | noteId, eventId, ciphertext hash               |
 * | createWorkspace, rotate-  | `wrapped_key`    | recipient (the X25519 public key the copy is   |
 * | WorkspaceKey,             |                  | sealed for), holder ("account", or the token   |
 * | approveConnect            |                  | id the copy is for), generation, hash of the   |
 * |                           |                  | decoded `encWorkspaceKey`                      |
 * | createWorkspace (1),      | `key_generation` | generation, recipientsHash (over the public    |
 * | rotateWorkspaceKey,       |                  | keys of every copy of the generation),         |
 * | approveConnect (re-signs  |                  | keyCommitment (sent as `keyCommitment`; signed |
 * | the current generation)   |                  | with `generationSignedAt` and                  |
 * |                           |                  | `generationSignature`)                         |
 * | revokeToken (a person)    | `token_revoked`  | recipient (the token's stored public key),     |
 * |                           |                  | tokenId                                        |
 * | writeNote with            | `check_applied`  | noteId, version = base + 1, folderId, body     |
 * | Knowtarium-Check-Id       |                  | hash, checkId (the applied check record)       |
 * | createFolder              | `folder_created` | folderId, parentId (absent at the root), hash  |
 * |                           |                  | of the decoded `encName`                       |
 * | updateFolder (a move)     | `folder_moved`   | folderId, parentId (the destination; absent:   |
 * |                           |                  | moved to the root)                             |
 * | setAgentPolicy            | `agent_policy`   | revision (= baseRevision + 1), policySha256    |
 * |                           |                  | (`agentPolicySha256` of the body's default and |
 * |                           |                  | folders)                                       |
 * | approveConnect (with a    | `agent_key`      | tokenId, signPublicKey (the agent's Ed25519    |
 * | `signPublicKey`)          |                  | key from the fragment), policyRevision (the    |
 * |                           |                  | server's current agent policy revision: the    |
 * |                           |                  | agent's floor); signed with `agentKeySignedAt` |
 * |                           |                  | and `agentKeySignature`                        |
 * | writeNoteAsAgent (signed  | `agent_edited`   | tokenId (the caller's), noteId, version =      |
 * | by the AGENT's key)       |                  | base + 1, folderId, body hash, revision (the   |
 * |                           |                  | agent policy revision header), policySha256    |
 * |                           |                  | (the stored hash of that revision, or          |
 * |                           |                  | `MISSING_AGENT_POLICY_SHA256` at revision 0)   |
 *
 * The common fields: `type`, `accountId` (the signer, the session's account), `workspaceId`, and
 * `createdAt` (the `signedAt` sent, in milliseconds, within `SIGNATURE_MAX_SKEW_SECONDS` of the
 * server's clock). A hash (`ciphertextSha256`) is the SHA-256 of the ciphertext bytes (for JSON
 * fields, of the decoded base64url), as 64 lowercase hex characters. A type has exactly these
 * fields, and optional ones are signed when present: `noteId` on `commented` and `recorded` (the
 * note the comment or event is on; every comment and event in this API is on a note, so the server
 * always includes it), `parentId` on the folder types (a folder at the root has no `parentId`,
 * never a null one), and `commentId` with `ciphertextSha256` on `rejected` (both or neither).
 * `version` and `revision` are 0 or more, `generation` 1 or more. `knowtarium/crypto`
 * (SIGNED_ENVELOPE_TYPES) has the same table, and the shared vectors test
 * (src/crypto/envelope-vectors.json) keeps the two identical. The signed bytes are
 * `envelopeSigningText(envelope)` in UTF-8 (all ASCII).
 *
 * `recipientsHash` is `recipientsHash()` of `knowtarium/crypto`: SHA-256 of the UTF-8 tag
 * "knowtarium-recipients-v1\n" followed by the generation's recipient X25519 public keys,
 * deduplicated, sorted by their bytes, each prefixed by its length (uint32 BE), as 64 lowercase
 * hex characters. The server computes it from
 * the public keys it stores for the generation's copies (the account's and each token's, revoked
 * ones included until the next generation), so the owner's word on who holds a generation can't be
 * swapped.
 *
 * `wrapped_key` names the recipient by its public key and its `holder`: `"account"` for the
 * owner's own copy, or the agent token id (from the request's `recipient`, or `tokenId` at
 * approveConnect). A client rotating a key takes each recipient's public key and token id from a
 * wrapped_key envelope it already verified, never from `listTokens`, the record's `recipient`
 * label or any other server field, so a server can't move one agent's copy to another's label.
 */

/** Prefix of every signed message: domain separation from anything else the key might sign. */
export const ENVELOPE_SIGNING_PREFIX = "knowtarium-envelope-v1\n";

/** How far `createdAt` may be from the server's clock. */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

/** A SHA-256 digest (32 bytes) as base64url. */
export const Sha256 = Base64Url.length(base64UrlLength(32));

/**
 * The SHA-256 of ciphertext inside a signed envelope, as 64 lowercase hex characters (what
 * `ciphertextSha256()` in `knowtarium/crypto` returns).
 */
export const CiphertextSha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "Expected a lowercase hex SHA-256" });

const base = { accountId: AccountId, workspaceId: WorkspaceId, createdAt: SignedTimestamp };

/**
 * A person's session applying an agent's passing check: the new version (the agent's `verified`
 * entry written into the note), signed like `edited` plus the check record's ID. It makes a note
 * version like `edited` does, but never confirms a person's `human:` entry.
 */
export const CheckAppliedEnvelope = z.strictObject({
  type: z.literal("check_applied"),
  ...base,
  noteId: NoteId,
  version: Version,
  folderId: FolderId,
  ciphertextSha256: CiphertextSha256,
  checkId: CheckId,
});
export type CheckAppliedEnvelope = z.infer<typeof CheckAppliedEnvelope>;

/** Who holds a wrapped copy: `"account"` (the owner's own copy) or the agent token id. */
export const WrappedKeyHolder = z.union([z.literal("account"), TokenId]);
export type WrappedKeyHolder = z.infer<typeof WrappedKeyHolder>;

/** The SHA-256 of a generation's recipient public keys, 64 lowercase hex characters. */
export const RecipientsHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "Expected a lowercase hex SHA-256" });

/**
 * The owner's commitment to a generation's workspace key (`workspaceKeyCommitment()` in
 * knowtarium/crypto: SHA-256 of a domain tag, the generation, the key and the workspace id), 64
 * lowercase hex characters. The server can't compute or check it (it never has the key): it takes
 * it from the request, signs nothing, and returns the signed envelope; clients holding the key
 * check it after unwrapping.
 */
export const KeyCommitment = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "Expected a lowercase hex SHA-256" });

/** The owner's word on a workspace key generation, who holds it and which key it is. */
export const KeyGenerationEnvelope = z.strictObject({
  type: z.literal("key_generation"),
  ...base,
  generation: KeyGeneration,
  recipientsHash: RecipientsHash,
  keyCommitment: KeyCommitment,
});
export type KeyGenerationEnvelope = z.infer<typeof KeyGenerationEnvelope>;

/** The owner's word that an agent token is revoked, naming the public key its copies used. */
export const TokenRevokedEnvelope = z.strictObject({
  type: z.literal("token_revoked"),
  ...base,
  recipient: PublicKey,
  tokenId: TokenId,
});
export type TokenRevokedEnvelope = z.infer<typeof TokenRevokedEnvelope>;

/**
 * The SHA-256 of an agent policy's rules (`agentPolicySha256` in agent-policy.ts), 64 lowercase
 * hex characters.
 */
export const AgentPolicySha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "Expected a lowercase hex SHA-256" });

/**
 * The owner's word on a workspace's agent policy: its revision and the hash of its rules (the
 * default mode and every folder override). Clients and the CLI check the policy they read
 * against it, so a server can't flip a folder to direct on its own.
 */
export const AgentPolicyEnvelope = z.strictObject({
  type: z.literal("agent_policy"),
  ...base,
  revision: Version,
  policySha256: AgentPolicySha256,
});
export type AgentPolicyEnvelope = z.infer<typeof AgentPolicyEnvelope>;

/**
 * The owner vouching for an agent token's Ed25519 signing key, and for the agent policy revision
 * current when the agent connected: the agent never accepts a policy below it, so an old policy
 * can't be replayed to it.
 */
export const AgentKeyEnvelope = z.strictObject({
  type: z.literal("agent_key"),
  ...base,
  tokenId: TokenId,
  /** The agent's Ed25519 public key (32 bytes, base64url). */
  signPublicKey: PublicKey,
  /** The agent policy revision when the agent connected (0: none yet): the agent's floor. */
  policyRevision: Version,
});
export type AgentKeyEnvelope = z.infer<typeof AgentKeyEnvelope>;

/**
 * An agent's direct write, signed with the agent's own key (the one its token's `agent_key`
 * names): like `edited`, plus the token id and the agent policy revision the agent checked, with
 * that revision's hash. `accountId` is the workspace owner's account.
 */
export const AgentEditedEnvelope = z.strictObject({
  type: z.literal("agent_edited"),
  ...base,
  tokenId: TokenId,
  noteId: NoteId,
  version: Version,
  folderId: FolderId,
  ciphertextSha256: CiphertextSha256,
  /** The agent policy revision the agent saw (0: no policy yet, which reads as direct). */
  revision: Version,
  /** `agentPolicySha256` of that revision (`MISSING_AGENT_POLICY_SHA256` at revision 0). */
  policySha256: AgentPolicySha256,
});
export type AgentEditedEnvelope = z.infer<typeof AgentEditedEnvelope>;

export const SignedEnvelope = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("edited"),
    ...base,
    noteId: NoteId,
    version: Version,
    folderId: FolderId,
    ciphertextSha256: CiphertextSha256,
  }),
  z.strictObject({ type: z.literal("deleted"), ...base, noteId: NoteId, version: Version }),
  z.strictObject({
    type: z.literal("approved"),
    ...base,
    /** The note the approved version belongs to. */
    noteId: NoteId,
    pendingId: PendingId,
    version: Version,
    /** The folder the approved version is stored in (the pending change's folder). */
    folderId: FolderId,
    ciphertextSha256: CiphertextSha256,
  }),
  z
    .strictObject({
      type: z.literal("rejected"),
      ...base,
      /** The note the rejected change was for. */
      noteId: NoteId,
      pendingId: PendingId,
      /** The comment the rejection leaves, if any, with the hash of its ciphertext. */
      commentId: CommentId.optional(),
      ciphertextSha256: CiphertextSha256.optional(),
    })
    .refine((value) => (value.commentId === undefined) === (value.ciphertextSha256 === undefined), {
      error: "A rejection's commentId and ciphertextSha256 come together",
    }),
  z.strictObject({
    type: z.literal("commented"),
    ...base,
    /** The note the comment is on. */
    noteId: NoteId.optional(),
    commentId: CommentId,
    revision: z.int().nonnegative(),
    ciphertextSha256: CiphertextSha256,
  }),
  z.strictObject({
    type: z.literal("recorded"),
    ...base,
    /** The note the event is about. */
    noteId: NoteId.optional(),
    eventId: EventId,
    ciphertextSha256: CiphertextSha256,
  }),
  z.strictObject({
    type: z.literal("wrapped_key"),
    ...base,
    /** The X25519 public key the workspace key is sealed for. */
    recipient: PublicKey,
    /** Who holds the copy: `"account"` (the owner's own) or the agent token id. */
    holder: WrappedKeyHolder,
    generation: KeyGeneration,
    ciphertextSha256: CiphertextSha256,
  }),
  KeyGenerationEnvelope,
  TokenRevokedEnvelope,
  CheckAppliedEnvelope,
  z.strictObject({
    type: z.literal("folder_created"),
    ...base,
    folderId: FolderId,
    /** The parent folder; absent at the workspace root. */
    parentId: FolderId.optional(),
    /** The hash of the encrypted folder name. */
    ciphertextSha256: CiphertextSha256,
  }),
  z.strictObject({
    type: z.literal("folder_moved"),
    ...base,
    folderId: FolderId,
    /** The destination parent folder; absent when the folder moves to the workspace root. */
    parentId: FolderId.optional(),
  }),
  AgentPolicyEnvelope,
  AgentKeyEnvelope,
  AgentEditedEnvelope,
]);
export type SignedEnvelope = z.infer<typeof SignedEnvelope>;
export type SignedAction = SignedEnvelope["type"];

/**
 * The envelope types protocol 2 added. A version 1 client can't parse them where its schema expects
 * a signed envelope (`listEvents`' `agent_edited` events), so the server answers it
 * `unsupported_protocol` there instead (an update notice, not a parse error). The `agent_key`
 * records do reach a version 1 caller, inside `listKeys`' `agentKeys`, which its schema doesn't
 * know and strips; `agent_policy` comes only from the protocol 2 policy routes.
 */
export const PROTOCOL_2_ENVELOPE_TYPES = [
  "agent_policy",
  "agent_key",
  "agent_edited",
] as const satisfies readonly SignedAction[];

/** The lowest protocol version that knows an envelope type: 2 for the agent types, else 1. */
export function envelopeProtocolVersion(type: SignedAction): 1 | 2 {
  return (PROTOCOL_2_ENVELOPE_TYPES as readonly SignedAction[]).includes(type) ? 2 : 1;
}

/**
 * A verifiable record of an action, as rows and responses carry it: a person's, or an agent's
 * direct write (`agent_edited`, under the agent's own key).
 */
export const SignedEvent = z.object({ envelope: SignedEnvelope, signature: Signature });
export type SignedEvent = z.infer<typeof SignedEvent>;

/** A signed `agent_policy`, as the server stores it and returns it with the policy. */
export const SignedAgentPolicy = z.object({ envelope: AgentPolicyEnvelope, signature: Signature });
export type SignedAgentPolicy = z.infer<typeof SignedAgentPolicy>;

/** A signed `agent_key`, as the server stores it and returns it in `listKeys` and at connect. */
export const SignedAgentKey = z.object({ envelope: AgentKeyEnvelope, signature: Signature });
export type SignedAgentKey = z.infer<typeof SignedAgentKey>;

/** A signed `key_generation`, as the server stores it and returns it with every wrapped copy. */
export const SignedKeyGeneration = z.object({
  envelope: KeyGenerationEnvelope,
  signature: Signature,
});
export type SignedKeyGeneration = z.infer<typeof SignedKeyGeneration>;

/** The envelope's canonical JSON (see `canonicalJson`), without the signing prefix. */
export function canonicalEnvelope(envelope: SignedEnvelope): string {
  return canonicalJson(envelope);
}

/** The exact text a signature covers: the signing prefix, then the canonical JSON. */
export function envelopeSigningText(envelope: SignedEnvelope): string {
  return ENVELOPE_SIGNING_PREFIX + canonicalEnvelope(envelope);
}

/** Signing fields in a JSON body; required from a person (session), refused from an agent. */
export const signingFields = {
  signedAt: SignedTimestamp.optional(),
  signature: Signature.optional(),
};

/** Signing fields in a JSON body that only a person sends. */
export const requiredSigningFields = { signedAt: SignedTimestamp, signature: Signature };

/**
 * The owner's signature on a key generation (`key_generation`), next to the signatures on the
 * wrapped copies: sent when a workspace is created (generation 1), on every rotation and when an
 * agent connects. `keyCommitment` is the envelope's commitment to the key, which the server
 * can't derive, so the request carries it; the server rebuilds the envelope with it.
 */
export const keyGenerationSigningFields = {
  keyCommitment: KeyCommitment,
  generationSignedAt: SignedTimestamp,
  generationSignature: Signature,
};

/**
 * The owner's signature on a new agent's signing key (`agent_key`), sent at `approveConnect` when
 * the CLI's fragment carried a `signPublicKey`: all three fields, or none for an older CLI.
 */
export const agentKeySigningFields = {
  signPublicKey: PublicKey.optional(),
  agentKeySignedAt: SignedTimestamp.optional(),
  agentKeySignature: Signature.optional(),
};

/** Both signing fields or neither. */
export function hasBothOrNeither(value: { signedAt?: unknown; signature?: unknown }): boolean {
  return (value.signedAt === undefined) === (value.signature === undefined);
}

/** Signing headers on a person's raw writes (and on an agent's `writeNoteAsAgent`). */
export const SigningHeaders = z.object({
  [headerKey(SIGNATURE_HEADER)]: Signature,
  [headerKey(SIGNED_AT_HEADER)]: SignedTimestamp,
});
export type SigningHeaders = z.infer<typeof SigningHeaders>;
