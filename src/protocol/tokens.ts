import { z } from "zod";

import { EncName, PublicKey, Signature } from "./ciphertext.js";
import { headerKey, SIGNATURE_HEADER, SIGNED_AT_HEADER } from "./headers.js";
import { FolderId, TokenId, WorkspaceId } from "./ids.js";
import { Ok, secretSchema, SignedTimestamp, Timestamp } from "./primitives.js";
import { defineRoute } from "./route.js";

/**
 * The secret an agent sends as `Authorization: Bearer kta_...`. The browser makes it at connect
 * time; the server only ever holds its SHA-256.
 */
export const AgentTokenSecret = secretSchema("kta");
export type AgentTokenSecret = z.infer<typeof AgentTokenSecret>;

export const TokenAccess = z.enum(["read", "read-write"]);
export type TokenAccess = z.infer<typeof TokenAccess>;

/**
 * An agent token and its scope: one workspace, optionally some folders (and their subfolders),
 * read or read-write. `folderIds` empty means the whole workspace.
 */
export const AgentToken = z.object({
  id: TokenId,
  workspaceId: WorkspaceId,
  /**
   * The name the person gave the agent, encrypted with the workspace key as an `agent_name` blob
   * bound to the token id (`encryptAgentName` in knowtarium/client). Absent for tokens made
   * before agents had names.
   */
  encName: EncName.optional(),
  access: TokenAccess,
  folderIds: z.array(FolderId),
  /**
   * The CLI's X25519 public key, as the server stored it at connect time. For display only: a
   * client sealing a key takes the recipient key from a verified wrapped_key envelope instead.
   */
  publicKey: PublicKey,
  /**
   * The agent's Ed25519 public key (protocol 2), which signs its direct writes (`agent_edited`);
   * null for a token connected before agents had one (it can only propose), and absent from
   * servers older than protocol 2. For display and lookup only: a client verifying a signature
   * takes the key from a verified `agent_key` envelope (`listKeys` `agentKeys`), never from here.
   */
  signPublicKey: PublicKey.nullable().optional(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
});
export type AgentToken = z.infer<typeof AgentToken>;

export const ListTokensQuery = z.strictObject({ workspaceId: WorkspaceId.optional() });
export type ListTokensQuery = z.infer<typeof ListTokensQuery>;

export const ListTokensResponse = z.object({ tokens: z.array(AgentToken) });
export type ListTokensResponse = z.infer<typeof ListTokensResponse>;

export const TokenResponse = z.object({ token: AgentToken });

/**
 * A revoked token. The token stops authenticating at once; its wrapped copies of the current
 * generation stay stored and listed in `listKeys` `recipients` with `revokedAt` (the owner-signed
 * `recipientsHash` covers them) until the next generation, which leaves them out. `mustRotateKey`
 * names the workspace whose key the token held: its owner must start a new key generation
 * (`rotateWorkspaceKey`, or `revokeAndRotate` in knowtarium/client) so the revoked agent can't
 * read new data. It
 * is null when the token held no key (already revoked, or revoked by the agent itself, whose
 * owner rotates on their next visit).
 */
export const RevokeTokenResponse = Ok.extend({
  mustRotateKey: z.object({ workspaceId: WorkspaceId }).nullable(),
});
export type RevokeTokenResponse = z.infer<typeof RevokeTokenResponse>;
export type TokenResponse = z.infer<typeof TokenResponse>;

/**
 * A person revoking a token signs it (`token_revoked`: the token id and the public key the server
 * stored for it at connect time), in the signing headers; the server verifies and stores the
 * envelope and returns it in `listKeys` (`revocations`), so no browser of the owner wraps a later
 * key for that public key. An agent revoking itself sends no signature (its owner rotates on their
 * next visit). Old clients that send no signature still revoke; the token just has no signed
 * record.
 */
export const RevokeTokenHeaders = z
  .object({
    [headerKey(SIGNATURE_HEADER)]: Signature.optional(),
    [headerKey(SIGNED_AT_HEADER)]: SignedTimestamp.optional(),
  })
  .refine(
    (value) =>
      (value[headerKey(SIGNATURE_HEADER)] === undefined) ===
      (value[headerKey(SIGNED_AT_HEADER)] === undefined),
    { error: "Send both signing headers, or neither" },
  );
export type RevokeTokenHeaders = z.infer<typeof RevokeTokenHeaders>;

export const tokenRoutes = {
  listTokens: defineRoute({
    method: "GET",
    path: "/tokens",
    auth: "session",
    summary: "The account's agent tokens",
    query: ListTokensQuery,
    response: ListTokensResponse,
  }),
  getCurrentToken: defineRoute({
    method: "GET",
    path: "/tokens/current",
    auth: "agent",
    summary: "The calling agent's own token and scope (`knowtarium status`)",
    response: TokenResponse,
  }),
  revokeToken: defineRoute({
    method: "DELETE",
    path: "/tokens/:tokenId",
    auth: "any",
    summary:
      "Revoke a token (an agent only its own); its copies stay listed with revokedAt until the next rotation",
    headers: RevokeTokenHeaders,
    response: RevokeTokenResponse,
  }),
};
