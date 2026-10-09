import { type ConnectDeps, runConnect } from "../connect/flow.js";
import type { Connection } from "../storage/credentials.js";
import type { ConnectAttempt } from "./server.js";
import type { WorkspaceSession } from "./session.js";

/**
 * Starts the connect flow for the MCP `connect` tool: no terminal, so a relayed delivery (which
 * needs its code confirmed) is refused and only the browser's loopback delivery completes it.
 * Resolves with the link once the browser was asked to open it (or rejects when the flow can't
 * start); `done` then settles with the new workspace's session, opened by `openSession`.
 */
export async function startConnectAttempt(
  deps: Omit<ConnectDeps, "interactive" | "confirm"> & {
    readonly openSession: (connection: Connection) => Promise<WorkspaceSession>;
  },
): Promise<ConnectAttempt> {
  let showUrl!: (url: string) => void;
  const url = new Promise<string>((resolve) => {
    showUrl = resolve;
  });
  const done = runConnect({
    ...deps,
    openUrl: (link) => {
      showUrl(link);
      return deps.openUrl(link);
    },
    interactive: false,
    confirm: () => Promise.resolve(false),
  }).then((delivered) => deps.openSession(delivered.connection));
  return { url: await Promise.race([url, done.then(() => url)]), done };
}
