import { parseArgs } from "node:util";

import {
  type AgentScopeProblem,
  createApiClient,
  isSyncApiError,
  NetworkError,
  verifyAgentScope,
} from "../../client/index.js";
import { fromBase64Url } from "../../crypto/index.js";
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
      permissions: [],
      verified: false,
      problem: checked.problem,
    };
  }
  return {
    revision: checked.revision,
    access: checked.verified?.scope.access ?? connection.access,
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
    let scope: ScopeReport = {
      revision: null,
      access: null,
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
      folderIds: connection.folderIds,
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
      `  access    ${entry.access}${entry.folderIds.length > 0 ? `, folders ${entry.folderIds.join(", ")}` : ", whole workspace"}`,
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
  readonly permissions: readonly AgentPermission[];
  readonly scopeRevision: number | null;
  readonly scopeVerified: boolean | null;
  readonly scopeProblem?: AgentScopeProblem;
}): string {
  const what =
    entry.permissions.length === 0
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
