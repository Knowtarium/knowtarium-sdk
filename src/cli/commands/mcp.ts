import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  EncryptedCache,
  standardSocketFactory,
  type StandardWebSocket,
} from "../../client/index.js";
import type { CliContext } from "../context.js";
import { startConnectAttempt } from "../mcp/connect-attempt.js";
import { GuardedCacheAdapter } from "../mcp/guarded-cache.js";
import { type ConnectAttempt, createKnowtariumServer } from "../mcp/server.js";
import { WorkspaceSession } from "../mcp/session.js";
import { type Connection, readConnectionSummaries } from "../storage/credentials.js";
import { FileCacheAdapter } from "../storage/file-cache.js";

/**
 * `knowtarium mcp [--actor <producer/version>] [--no-live]`: the MCP server agents start over
 * stdio. It answers at once and opens every connected workspace in the background (the encrypted
 * local cache first, then a pull, then live pings); a workspace that fails says why in the tools
 * and never stops the others. With nothing connected it still runs: a `connect` tool runs the
 * connect flow from the agent (the browser opens; no terminal needed, as in Claude Desktop).
 * stdout carries only the protocol; messages go to stderr.
 */
export async function mcpCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { actor: { type: "string" }, "no-live": { type: "boolean" } },
  });
  const log = (line: string) => {
    context.io.err(line);
  };
  let connections: Connection[] = [];
  let notConnected: string | undefined;
  try {
    connections = await (await context.credentials()).list();
  } catch (error) {
    notConnected = error instanceof Error ? error.message : String(error);
    log(`knowtarium: ${notConnected}`);
  }
  if (connections.length === 0 && notConnected === undefined) {
    log(
      "knowtarium: not connected. Use the connect tool, or run `npx knowtarium connect` from your home folder.",
    );
  }

  const adapter = new GuardedCacheAdapter(new FileCacheAdapter(context.env.cache));
  const cache = new EncryptedCache(adapter);
  const WebSocketClass = (globalThis as { WebSocket?: new (url: string) => StandardWebSocket })
    .WebSocket;
  const open = (connection: Connection) =>
    WorkspaceSession.open(connection, {
      fetch: context.fetch,
      trust: context.trust,
      cache,
      adapter,
      log,
      stillConnected: async () => {
        try {
          const saved = await readConnectionSummaries(context.env.home);
          return saved.some(
            (entry) =>
              entry.workspaceId === connection.workspaceId && entry.tokenId === connection.tokenId,
          );
        } catch {
          return true;
        }
      },
      onDisconnected: () => {
        adapter.stop(connection.workspaceId);
      },
    });
  // opens in the background: the server answers meanwhile, and each workspace fails on its own
  const start = (session: WorkspaceSession) => {
    void session.start().then(() => {
      if (values["no-live"] !== true && WebSocketClass !== undefined && !session.ended) {
        try {
          session.goLive(standardSocketFactory(WebSocketClass));
        } catch {
          // live pings are an optimization; the tools still answer
        }
      }
    });
  };

  const sessions = await Promise.all(connections.map(open));
  const connect = async (): Promise<ConnectAttempt> =>
    startConnectAttempt({
      apiUrl: context.env.apiUrl,
      appUrl: context.env.appUrl,
      cliVersion: context.version,
      fetch: context.fetch,
      credentials: await context.credentials(),
      trust: context.trust,
      openUrl: (link) => context.io.openUrl(link),
      print: log,
      openSession: async (connection) => {
        const session = await open(connection);
        start(session);
        return session;
      },
    });
  const server = createKnowtariumServer(sessions, {
    version: context.version,
    ...(values.actor === undefined ? {} : { actor: values.actor }),
    ...(notConnected === undefined ? { connect } : { notConnected }),
  });
  await server.connect(new StdioServerTransport());
  for (const session of sessions) start(session);

  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
  for (const session of sessions) session.stop();
  await server.close();
  // let the last answers reach the agent before the process exits
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => {
      resolve();
    });
  });
  return 0;
}
