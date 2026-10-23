import { z } from "zod";

import { FolderId } from "./ids.js";
import { sha256Hex } from "./sha256.js";

/*
 * Agent permissions (protocol 3): what a connected agent may do beyond reading and, with
 * `read-write`, creating, editing and renaming notes. Each permission is one MCP tool and one
 * server check; all are off by default, and a token made before them has none. Moving a note
 * needs `notes.move` too, directly or as a proposal.
 *
 * A token's scope is its access, its folders and its permissions together. The owner signs every
 * scope it gives a token as an `agent_scope` envelope (signatures.ts): revision 1 at connect, then
 * one more for each change (`updateTokenScope`), over `agentScopeSha256` of the scope. The CLI
 * verifies it under the owner key it pinned at connect and keeps the highest revision it verified
 * (a floor), so a server can't widen what the agent believes it may do, nor roll it back. A token
 * at revision 0 (connected before scopes were signed) has no signed scope and no permissions: its
 * access and folders are what the CLI stored at connect.
 *
 * The server enforces the scope, not cryptography: the agent holds the workspace key. Every
 * agent action on the new routes is signed with the agent's own key and names the scope revision
 * it acted under, so the web app can audit it against the revisions the owner signed.
 */

/** Whether a token may only read, or also change notes. */
export const TokenAccess = z.enum(["read", "read-write"]);
export type TokenAccess = z.infer<typeof TokenAccess>;

/**
 * What an agent may do on top of `read-write`, in this order (also their order in the scope
 * hash): move a note to another folder, delete a note, create (or revive) a folder, rename one,
 * move one, delete an empty one. Adding one needs a protocol bump: `AgentToken.permissions` and
 * `agentScopeText` refuse a value they don't know, so a client of this version would fail on it.
 */
export const AgentPermission = z.enum([
  "notes.move",
  "notes.delete",
  "folders.create",
  "folders.rename",
  "folders.move",
  "folders.delete",
]);
export type AgentPermission = z.infer<typeof AgentPermission>;

/** Every permission, in `AgentPermission` order. */
export const AGENT_PERMISSIONS: readonly AgentPermission[] = AgentPermission.options;

/** The most folders a token's scope names (as at connect). */
export const AGENT_SCOPE_FOLDERS_MAX = 100;

/** A token's scope as the owner signs it: access, folders (empty: the whole workspace), permissions. */
export const AgentScopeBody = z.object({
  access: TokenAccess,
  folderIds: z.array(FolderId).max(AGENT_SCOPE_FOLDERS_MAX),
  permissions: z.array(AgentPermission),
});
export type AgentScopeBody = z.infer<typeof AgentScopeBody>;

/** `agentScopeSha256` of a scope, 64 lowercase hex characters. */
export const AgentScopeSha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "Expected a lowercase hex SHA-256" });

/**
 * The oldest CLI that knows permissions (from a connect request's `cliVersion`): the web app
 * disables the permission pickers for an older one, which would never offer the tools. The
 * release that ships them (t-140) sets it to its own version.
 */
export const AGENT_PERMISSIONS_MIN_CLI_VERSION = "0.1.4";

/**
 * The `prevScopeSha256` of revision 1, which has no revision before it: 64 zeros (no scope text
 * hashes to it).
 */
export const NO_PREVIOUS_AGENT_SCOPE_SHA256 = "0".repeat(64);

/** Domain tag of a scope hash (`agentScopeSha256`). */
export const AGENT_SCOPE_HASH_TAG = "knowtarium-agent-scope-v1\n";

/**
 * A scope's permissions in `AgentPermission` order, each once. Throws a `TypeError` for one that
 * isn't a permission.
 */
export function sortAgentPermissions(permissions: readonly string[]): AgentPermission[] {
  const unknown = permissions.find((permission) => !AgentPermission.safeParse(permission).success);
  if (unknown !== undefined) throw new TypeError("sortAgentPermissions: unknown permission");
  return AGENT_PERMISSIONS.filter((permission) => permissions.includes(permission));
}

/**
 * The text a scope hash covers: the tag, then the canonical JSON (RFC 8785) of
 * `{"access", "folderIds", "permissions"}`, with `folderIds` sorted and deduplicated and
 * `permissions` in `AgentPermission` order, each once. Throws a `TypeError` for an unknown access
 * or permission, or a malformed folder id.
 */
export function agentScopeText(scope: {
  readonly access: string;
  readonly folderIds: readonly string[];
  readonly permissions: readonly string[];
}): string {
  if (!TokenAccess.safeParse(scope.access).success) {
    throw new TypeError("agentScopeText: unknown access");
  }
  if (!scope.folderIds.every((folderId) => FolderId.safeParse(folderId).success)) {
    throw new TypeError("agentScopeText: expected folder ids");
  }
  const folderIds = [...new Set(scope.folderIds)].sort();
  const permissions = sortAgentPermissions(scope.permissions);
  const list = (values: readonly string[]) =>
    values.map((value) => JSON.stringify(value)).join(",");
  return `${AGENT_SCOPE_HASH_TAG}{"access":${JSON.stringify(scope.access)},"folderIds":[${list(folderIds)}],"permissions":[${list(permissions)}]}`;
}

/**
 * The `scopeSha256` an `agent_scope` signs: SHA-256 of `agentScopeText`, as 64 lowercase hex
 * characters. The order of the folders and permissions doesn't matter. Uses Web Crypto. Throws
 * what `agentScopeText` throws, and an `Error` where Web Crypto is missing.
 */
export async function agentScopeSha256(scope: {
  readonly access: string;
  readonly folderIds: readonly string[];
  readonly permissions: readonly string[];
}): Promise<string> {
  return sha256Hex(agentScopeText(scope));
}

/**
 * Whether a scope lets the agent do what a permission covers: `read-write`, and the permission
 * among its permissions.
 */
export function agentScopeAllows(
  scope: { readonly access: string; readonly permissions: readonly string[] },
  permission: AgentPermission,
): boolean {
  return scope.access === "read-write" && scope.permissions.includes(permission);
}
