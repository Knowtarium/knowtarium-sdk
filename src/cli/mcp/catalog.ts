import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { createKnowtariumServer } from "./server.js";
import type { WorkspaceSession } from "./session.js";

/** A tool as a listing shows it: its name, title, description and annotations. */
export interface CatalogTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: ToolAnnotations;
}

/**
 * Every tool the server can offer, in the order it lists them: the reading and writing tools of a
 * connection that may write, then `connect`, offered only while nothing is connected. Read from
 * the real tool definitions over an in-memory MCP exchange, so the Claude Desktop bundle's
 * manifest lists exactly these (scripts/build-extras.js builds this module and calls it). No tool
 * runs: the sessions are stand-ins that only say they may write.
 */
export async function toolCatalog(): Promise<CatalogTool[]> {
  const writer = { writable: true } as unknown as WorkspaceSession;
  const connected = await listTools(createKnowtariumServer([writer], { version: "0.0.0" }));
  const unconnected = await listTools(
    createKnowtariumServer([], {
      version: "0.0.0",
      connect: () => Promise.reject(new Error("the catalog never connects")),
    }),
  );
  const names = new Set(connected.map((tool) => tool.name));
  return [...connected, ...unconnected.filter((tool) => !names.has(tool.name))];
}

async function listTools(
  server: ReturnType<typeof createKnowtariumServer>,
): Promise<CatalogTool[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "knowtarium-catalog", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools.map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    }));
  } finally {
    await client.close();
  }
}
