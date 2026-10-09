import { parseArgs } from "node:util";

import { createApiClient, isSyncApiError, NetworkError } from "../../client/index.js";
import { routes } from "../../protocol/index.js";
import type { CliContext } from "../context.js";
import { needsUpdate, updateMessage } from "../update.js";

/**
 * `knowtarium disconnect [--workspace <id>] [--all]`: revokes the agent token with the API, then
 * deletes the connection, its encrypted cache, the pinned owner key and the credentials key when
 * nothing is left. The
 * local copy is wiped even when the API can't be reached (it says so).
 */
export async function disconnectCommand(
  context: CliContext,
  argv: readonly string[],
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { workspace: { type: "string" }, all: { type: "boolean" } },
  });
  const { io } = context;
  const connections = await (await context.credentials()).list();
  const chosen =
    values.all === true
      ? connections
      : values.workspace !== undefined
        ? connections.filter((entry) => entry.workspaceId === values.workspace)
        : connections.length === 1
          ? connections
          : [];
  if (chosen.length === 0) {
    io.err(
      connections.length === 0
        ? "Not connected."
        : "Several workspaces are connected: pass --workspace <id> or --all.",
    );
    return 1;
  }
  let failed = false;
  for (const connection of chosen) {
    const api = createApiClient({
      baseUrl: connection.apiUrl,
      fetch: context.fetch,
      auth: { kind: "agent", token: connection.tokenSecret },
      timeoutMs: 15_000,
    });
    try {
      await api.call(routes.revokeToken, { params: { tokenId: connection.tokenId } });
      io.out(`Revoked the token for workspace ${connection.workspaceId}.`);
    } catch (error) {
      if (isSyncApiError(error, "token_revoked") || isSyncApiError(error, "unauthenticated")) {
        io.out(`The token for workspace ${connection.workspaceId} was already revoked.`);
      } else if (needsUpdate(error)) {
        failed = true;
        io.err(
          `${updateMessage(context.version, error)} Meanwhile, revoke the token for ${connection.workspaceId} in the web app's settings.`,
        );
      } else if (error instanceof NetworkError || isSyncApiError(error)) {
        failed = true;
        io.err(
          `Couldn't reach the API to revoke the token for ${connection.workspaceId}: revoke it in the web app's settings.`,
        );
      } else throw error;
    }
    await context.cache.clearWorkspace(connection.workspaceId);
    await (await context.credentials()).remove(connection.workspaceId);
    await context.trust.unpinOwnerKey(connection.workspaceId);
    io.out(`Deleted the local keys and cache for workspace ${connection.workspaceId}.`);
  }
  return failed ? 1 : 0;
}
