import { parseArgs } from "node:util";

import {
  type AgentScopeProblem,
  type ApiClient,
  createApiClient,
  decryptFolderName,
  isSyncApiError,
  NetworkError,
  verifyAgentScope,
} from "../../client/index.js";
import { boxKeyPairFromPrivateKey, fromBase64Url } from "../../crypto/index.js";
import { cachedKeyProvider } from "../mcp/key-cache.js";
import { FileCacheAdapter } from "../storage/file-cache.js";
import { type AgentPermission, type AgentToken, routes } from "../../protocol/index.js";
import {
  type AgentChanges,
  agentChangesWithout,
  describeAgentChanges,
  readAgentChanges,
} from "../agent-changes.js";
import type { CliContext } from "../context.js";
import { needsUpdate } from "../update.js";
import {
  type Connection,
  type Credentials,
  readConnectionSummaries,
  writesDirectly,
} from "../storage/credentials.js";

/**
 * A token's scope as `status` reports it (protocol 3): its permissions and revision from the
 * owner's signed scope, verified under the pinned owner key at or above this computer's floor;
 * `verified` false at revision 0 (never signed) and when it didn't verify (`problem`), null
 * offline.
 */
interface ScopeReport {
  readonly revision: number | null;
  readonly access: "read" | "read-write" | null;
  /** The folders the verified scope gives (null: as saved at connect). */
  readonly folderIds: readonly string[] | null;
  readonly permissions: readonly AgentPermission[];
  readonly verified: boolean | null;
  readonly problem: AgentScopeProblem | null;
}

/** Checks a token's signed scope as the MCP server does, against this computer's floor. */
async function scopeReport(
  context: CliContext,
  credentials: Credentials,
  connection: Connection,
  token: AgentToken,
): Promise<ScopeReport> {
  const floor = await credentials
    .scopeFloor(connection.workspaceId, connection.tokenId)
    .catch(() => undefined);
  const pinned = await context.trust.ownerKey(connection.workspaceId);
  const checked = await verifyAgentScope(token.scope, {
    ownerSigningPublicKey: pinned ?? fromBase64Url(connection.ownerSignPublicKey),
    accountId: connection.ownerId,
    workspaceId: connection.workspaceId,
    tokenId: connection.tokenId,
    minRevision: floor?.revision ?? 0,
    ...(floor === undefined ? {} : { floorScopeSha256: floor.signed.envelope.scopeSha256 }),
  });
  if (!checked.ok) {
    return {
      revision: token.scopeRevision,
      access: null,
      folderIds: null,
      permissions: [],
      verified: false,
      problem: checked.problem,
    };
  }
  return {
    revision: checked.revision,
    access: checked.verified?.scope.access ?? connection.access,
    folderIds: checked.verified?.scope.folderIds ?? null,
    permissions: checked.verified?.scope.permissions ?? [],
    verified: checked.verified !== null,
    problem: null,
  };
}

/**
 * `knowtarium status [--offline] [--json]`: every connection, its scope, how its agent changes
 * notes (written directly or proposed; online, with the workspace's checked policy), cache and
 * token state.
 */
export async function statusCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { offline: { type: "boolean" }, json: { type: "boolean" } },
  });
  const { io } = context;
  const offline = values.offline === true;
  // offline, only the summaries are read, so the keychain is never opened
  const connections = offline
    ? await readConnectionSummaries(context.env.home)
    : await (await context.credentials()).list();
  const report = [];
  for (const connection of connections) {
    let token: "active" | "revoked" | "unknown" | "unreachable" = "unknown";
    let folderNames: string[] | null = null;
    let scope: ScopeReport = {
      revision: null,
      access: null,
      folderIds: null,
      permissions: [],
      verified: null,
      problem: null,
    };
    const secret = (connection as Partial<Connection>).tokenSecret;
    if (!offline && secret !== undefined) {
      const api = createApiClient({
        baseUrl: connection.apiUrl,
        fetch: context.fetch,
        auth: { kind: "agent", token: secret },
        retry: { maxAttempts: 1 },
        timeoutMs: 10_000,
      });
      try {
        const { data } = await api.call(routes.getCurrentToken);
        token = "active";
        scope = await scopeReport(
          context,
          await context.credentials(),
          connection as Connection,
          data.token,
        );
        folderNames = await scopeFolderNames(
          context,
          connection as Connection,
          api,
          scope.folderIds ?? connection.folderIds,
        );
      } catch (error) {
        // this version can't talk to Knowtarium at all: the command says to update
        if (needsUpdate(error)) throw error;
        if (isSyncApiError(error, "token_revoked") || isSyncApiError(error, "unauthenticated")) {
          token = "revoked";
        } else if (
          error instanceof NetworkError ||
          (isSyncApiError(error) && error.status >= 500)
        ) {
          token = "unreachable";
        } else if (!isSyncApiError(error)) throw error;
      }
    }
    // online and still connected: the workspace's policy, checked; offline: unknown
    // the access the owner's verified scope gives, else the one saved at connect
    const access = scope.access ?? connection.access;
    const agentChanges: AgentChanges =
      access === "read"
        ? agentChangesWithout("none")
        : token === "revoked"
          ? agentChangesWithout("revoked")
          : token === "active"
            ? await readAgentChanges(connection as Connection, {
                fetch: context.fetch,
                trust: context.trust,
              })
            : offline
              ? agentChangesWithout("unknown")
              : agentChangesWithout(
                  writesDirectly(connection as Connection) ? "direct" : "propose",
                );
    report.push({
      workspaceId: connection.workspaceId,
      tokenId: connection.tokenId,
      access,
      folderIds: scope.folderIds ?? connection.folderIds,
      // the scope folders' paths, read with the workspace key (null: offline, or unreadable)
      folders: folderNames,
      permissions: scope.permissions,
      scopeRevision: scope.revision,
      scopeVerified: scope.verified,
      ...(scope.problem === null ? {} : { scopeProblem: scope.problem }),
      apiUrl: connection.apiUrl,
      connectedAt: connection.connectedAt,
      token,
      agentChanges,
      cacheCursor: await context.cache.cursor(connection.workspaceId),
    });
  }
  if (values.json === true) {
    const secretStore = offline ? null : (await context.secrets()).kind;
    io.out(JSON.stringify({ secretStore, connections: report }, null, 2));
    return 0;
  }
  if (report.length === 0) {
    io.out("Not connected. Run `knowtarium connect` to connect a workspace.");
    return 0;
  }
  if (!offline) {
    const kind = (await context.secrets()).kind;
    io.out(
      `Keys are kept in: ${kind === "keychain" ? "the OS keychain" : "a private file (no keychain available)"}`,
    );
  }
  if (report.some((entry) => entry.token === "unreachable")) {
    io.out(
      "Knowtarium can't be reached right now, so whether the tokens still work is unknown; the local copies still answer agents. Try again later, or use --offline.",
    );
  }
  for (const entry of report) {
    io.out(`Workspace ${entry.workspaceId}`);
    io.out(`  token     ${entry.tokenId} (${entry.token})`);
    io.out(
      `  access    ${entry.access}${entry.folderIds.length > 0 ? `, folders ${(entry.folders ?? entry.folderIds).join(", ")}` : ", whole workspace"}`,
    );
    io.out(`  changes   ${describeAgentChanges(entry.agentChanges)}`);
    if (entry.scopeVerified !== null) io.out(`  allowed   ${describeScope(entry)}`);
    if (entry.token === "revoked") {
      io.out(
        `            (its access was revoked in the web app, or its account was deleted: run \`npx knowtarium disconnect --workspace ${entry.workspaceId}\` to remove it from this computer, or \`npx knowtarium connect\` to connect it again, from your home folder)`,
      );
    }
    if (entry.agentChanges.writes === "propose") {
      io.out(
        "            (made before agents could write directly, or the owner didn't vouch for its signing key: run `npx knowtarium connect` again from your home folder, then restart your agents, to let them write directly where the workspace allows it)",
      );
    }
    io.out(`  api       ${entry.apiUrl}`);
    io.out(`  cache     at workspace version ${String(entry.cacheCursor)}`);
  }
  return report.some((entry) => entry.token === "revoked") ? 1 : 0;
}

/** The permissions line: what the agent may do beyond read-write, and how sure that is. */
function describeScope(entry: {
  readonly access: "read" | "read-write";
  readonly permissions: readonly AgentPermission[];
  readonly scopeRevision: number | null;
  readonly scopeVerified: boolean | null;
  readonly scopeProblem?: AgentScopeProblem;
}): string {
  const what =
    entry.access === "read"
      ? "read only: no changes, so no permissions"
      : entry.permissions.length === 0
        ? "no permissions beyond read-write"
        : entry.permissions.join(", ");
  if (entry.scopeProblem !== undefined) {
    return `${what} (the scope Knowtarium served didn't verify: ${entry.scopeProblem}; the last verified one applies)`;
  }
  if (entry.scopeVerified === true) {
    return `${what} (scope revision ${String(entry.scopeRevision)}, signed by the workspace owner)`;
  }
  return `${what} (no signed scope yet: the workspace owner can give it permissions in its agent settings)`;
}

/**
 * The paths of a connection's scope folders, decrypted with the workspace key (from the local
 * cache, else fetched and verified as the MCP server does); null when they can't be read, and the
 * IDs are shown instead.
 */
async function scopeFolderNames(
  context: CliContext,
  connection: Connection,
  api: ApiClient,
  folderIds: readonly string[],
): Promise<string[] | null> {
  if (folderIds.length === 0) return [];
  try {
    const pinned = await context.trust.ownerKey(connection.workspaceId);
    const keys = await cachedKeyProvider(
      api,
      {
        workspaceId: connection.workspaceId,
        recipient: boxKeyPairFromPrivateKey(fromBase64Url(connection.agentPrivateKey)),
        ownerSigningPublicKey: pinned ?? fromBase64Url(connection.ownerSignPublicKey),
        ownerAccountId: connection.ownerId,
        trust: context.trust,
      },
      new FileCacheAdapter(context.env.cache),
    ).get();
    const { data } = await api.call(routes.listFolders, {
      params: { workspaceId: connection.workspaceId },
    });
    const byId = new Map(data.folders.map((folder) => [folder.id as string, folder]));
    const nameOf = (folderId: string): string => {
      const folder = byId.get(folderId);
      if (folder === undefined) return folderId;
      return decryptFolderName(
        keys,
        { workspaceId: connection.workspaceId, folderId: folder.id },
        folder.encName,
      );
    };
    const pathOf = (folderId: string, depth = 0): string => {
      const parentId = byId.get(folderId)?.parentId ?? null;
      const name = nameOf(folderId);
      if (parentId === null || depth > 64) return name === "" ? "(root folder)" : name;
      const parent = pathOf(parentId, depth + 1);
      return parent === "(root folder)" ? name : `${parent}/${name}`;
    };
    return folderIds.map((folderId) => pathOf(folderId));
  } catch {
    return null;
  }
}
