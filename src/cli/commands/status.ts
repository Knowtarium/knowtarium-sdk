import { parseArgs } from "node:util";

import { createApiClient, isSyncApiError, NetworkError } from "../../client/index.js";
import { routes } from "../../protocol/index.js";
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
  readConnectionSummaries,
  writesDirectly,
} from "../storage/credentials.js";

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
        await api.call(routes.getCurrentToken);
        token = "active";
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
    const agentChanges: AgentChanges =
      connection.access === "read"
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
      access: connection.access,
      folderIds: connection.folderIds,
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
    if (entry.token === "revoked") {
      io.out(
        `            (its access was revoked in the web app, or its account was deleted: run \`knowtarium disconnect --workspace ${entry.workspaceId}\` to remove it from this computer, or \`knowtarium connect\` to connect it again)`,
      );
    }
    if (entry.agentChanges.writes === "propose") {
      io.out(
        "            (made before agents could write directly, or the owner didn't vouch for its signing key: run `knowtarium connect` again, then restart your agents, to let them write directly where the workspace allows it)",
      );
    }
    io.out(`  api       ${entry.apiUrl}`);
    io.out(`  cache     at workspace version ${String(entry.cacheCursor)}`);
  }
  return report.some((entry) => entry.token === "revoked") ? 1 : 0;
}
