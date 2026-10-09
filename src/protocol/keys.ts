import { z } from "zod";

import { EncKey } from "./ciphertext.js";
import { AccountId, TokenId, WorkspaceId } from "./ids.js";
import { KeyGeneration, Timestamp } from "./primitives.js";
import { defineRoute } from "./route.js";
import {
  keyGenerationSigningFields,
  requiredSigningFields,
  SignedAgentKey,
  SignedEvent,
  SignedKeyGeneration,
} from "./signatures.js";
import { Workspace } from "./workspaces.js";

/** Who a wrapped workspace key is sealed for: the account, or one agent token's public key. */
export const KeyRecipient = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), accountId: AccountId }),
  z.strictObject({ kind: z.literal("token"), tokenId: TokenId }),
]);
export type KeyRecipient = z.infer<typeof KeyRecipient>;

/**
 * One copy of a workspace key, sealed (X25519) for one recipient and signed by the owner
 * (`wrapped_key`, naming the recipient's public key and its holder: `"account"` for the account's
 * copy, the token id for a token's, matching `recipient`), with the owner's signed `key_generation`
 * for its generation. Clients verify both signatures before unwrapping (`unwrapSignedWorkspaceKey`
 * in `knowtarium/crypto`), check that `signed.envelope.recipient` is their own public key, and
 * refuse a generation without a valid owner signature.
 */
export const WrappedWorkspaceKey = z.object({
  workspaceId: WorkspaceId,
  recipient: KeyRecipient,
  keyGeneration: KeyGeneration,
  encWorkspaceKey: EncKey,
  createdAt: Timestamp,
  signed: SignedEvent,
  /** The owner's signed `key_generation` for `keyGeneration`, as the server stored it. */
  signedGeneration: SignedKeyGeneration,
});
export type WrappedWorkspaceKey = z.infer<typeof WrappedWorkspaceKey>;

/**
 * One recipient's copy of a workspace's current generation (`listKeys` `recipients`), as stored.
 * A revoked token's copy stays listed (with `revokedAt`) until the next generation, because the
 * owner-signed `recipientsHash` of the generation covers it: clients need every copy to check the
 * set, and leave revoked ones out of the next generation.
 */
export const RecipientKey = WrappedWorkspaceKey.extend({ revokedAt: Timestamp.nullable() });
export type RecipientKey = z.infer<typeof RecipientKey>;

/** An owner-signed revocation of an agent token (`token_revoked`), as `revokeToken` stored it. */
export const TokenRevocation = z.object({
  workspaceId: WorkspaceId,
  tokenId: TokenId,
  signed: SignedEvent,
});
export type TokenRevocation = z.infer<typeof TokenRevocation>;

/**
 * An agent token's signing key, as the owner vouched for it at connect time (`agent_key`, whose
 * envelope names the workspace, the token id, the key and the policy floor). Verify `signed` with
 * the owner's key before trusting an `agent_edited` signature under its `signPublicKey`. A revoked
 * token's key stays listed (with `revokedAt`), so the versions it wrote before still verify.
 */
export const AgentKeyRecord = z.object({
  signed: SignedAgentKey,
  revokedAt: Timestamp.nullable(),
});
export type AgentKeyRecord = z.infer<typeof AgentKeyRecord>;

/**
 * The caller's own wrapped keys: every generation of every workspace key sealed for the account
 * (session), or for the token (agent).
 *
 * `recipients`, for an owner session only: for each workspace the account owns, the current
 * generation's copy for every recipient (the account and every agent token, revoked ones marked),
 * each with the owner-signed `wrapped_key` envelope naming its recipient's public key and the
 * generation's latest `key_generation` (whose `recipientsHash` covers them all). `revocations`, for
 * an owner session only: every owner-signed `token_revoked` of those workspaces. A rotation
 * re-wraps the new key only for the owner-signed set of the generation it replaces, minus revoked
 * keys (`rotationRecipients` in knowtarium/client), never from `listTokens`. Both are absent for
 * agents and from servers that don't send them yet.
 *
 * `agentKeys` (protocol 2), for sessions and agents: every vouched agent signing key of the
 * caller's workspaces (an agent: of its own workspace, its own and other agents'), revoked ones
 * included, to verify `agent_edited` signatures. Absent from servers that don't send it yet.
 */
export const ListKeysResponse = z.object({
  workspaceKeys: z.array(WrappedWorkspaceKey),
  recipients: z.array(RecipientKey).max(10_000).optional(),
  revocations: z.array(TokenRevocation).max(10_000).optional(),
  agentKeys: z.array(AgentKeyRecord).max(10_000).optional(),
});
export type ListKeysResponse = z.infer<typeof ListKeysResponse>;

/**
 * A new key generation, signed by the owner (`key_generation`, from `generationSignedAt` and
 * `generationSignature`), wrapped for the account and every remaining agent token, each copy signed
 * (`wrapped_key`). The server verifies every signature, stores the `key_generation` one and
 * returns it with every copy (`listKeys`). Sent after a token is revoked; old data stays under its
 * old generation. Each
 * token's public key and id come from the wrapped_key envelope the client verified before (from
 * `listKeys`), never from `listTokens`; the server rebuilds each envelope with the recipient key
 * it stored at connect time and `holder` from `recipient` (`"account"` or the token id), so a
 * swapped key or label fails verification. A wrap for a revoked token is refused.
 */
export const RotateKeyRequest = z.strictObject({
  keyGeneration: KeyGeneration,
  ...keyGenerationSigningFields,
  wrappedKeys: z
    .array(
      z.strictObject({
        recipient: KeyRecipient,
        encWorkspaceKey: EncKey,
        ...requiredSigningFields,
      }),
    )
    .min(1),
});
export type RotateKeyRequest = z.infer<typeof RotateKeyRequest>;

export const RotateKeyResponse = z.object({ workspace: Workspace });
export type RotateKeyResponse = z.infer<typeof RotateKeyResponse>;

export const keyRoutes = {
  listKeys: defineRoute({
    method: "GET",
    path: "/keys",
    auth: "any",
    summary: "The caller's wrapped workspace keys",
    response: ListKeysResponse,
  }),
  rotateWorkspaceKey: defineRoute({
    method: "POST",
    path: "/workspaces/:workspaceId/key-generations",
    auth: "session",
    summary: "Start a new key generation with its wrapped copies",
    body: RotateKeyRequest,
    response: RotateKeyResponse,
  }),
};
