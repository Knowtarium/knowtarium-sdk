// The `connect` tool: with nothing connected, an agent (Claude Desktop, no terminal) starts the
// connect flow, gets the link, and once the browser delivered, the workspace's tools work.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { fromBase64Url, ready, toBase64Url, wrapAndSignWorkspaceKey } from "../../crypto/index.js";
import { loopbackConnectUrl, parseConnectFragment } from "../../protocol/index.js";
import { EncryptedCache, MemoryCacheAdapter, newId, type Scheduler } from "../../client/index.js";
import { World } from "../../client/testing/world.js";
import { wrappedRecord } from "../../client/testing/wrapped.js";
import { temporaryFolder, testContext } from "../testing/context.js";
import { startConnectAttempt } from "./connect-attempt.js";
import { createKnowtariumServer } from "./server.js";
import { WorkspaceSession } from "./session.js";

beforeAll(ready);

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

const fast: Scheduler = {
  setTimeout: (callback) => setTimeout(callback, 5),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  now: () => Date.now(),
};

/** What the web app posts to the CLI's loopback once the person approved. */
async function approveInBrowser(world: World, url: string): Promise<void> {
  const parsed = new URL(url);
  const fragment = parseConnectFragment(parsed.hash);
  if (fragment === null) throw new Error("no fragment");
  const signed = wrapAndSignWorkspaceKey(world.key, fromBase64Url(fragment.publicKey), {
    accountId: world.accountId,
    workspaceId: world.workspaceId,
    signing: world.account.signing,
    holder: world.tokenId,
  });
  const body = {
    requestId: parsed.searchParams.get("request") ?? "",
    tokenSecret: world.agentToken,
    token: world.server.agentTokenInfo(),
    ownerId: world.accountId,
    ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
    wrappedKey: wrappedRecord(
      world.workspaceId,
      { kind: "token", tokenId: world.tokenId },
      signed,
      1,
    ),
    secret: fragment.secret,
  };
  // the sync API keeps the key wrapped for this CLI as the token's copy
  world.server.agentKeys = [body.wrappedKey];
  const answer = await fetch(loopbackConnectUrl(fragment.port), {
    method: "POST",
    headers: { Origin: "https://app.test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(await answer.json()).toEqual({ ok: true });
}

describe("the connect tool", () => {
  it("connects from the agent, then the workspace's tools work", async () => {
    const world = new World();
    await world.web().engine.writeNote({
      noteId: newId("note"),
      folderId: world.folderId,
      baseVersion: 0,
      name: "hello.md",
      text: "---\ntype: Note\ntitle: Hello\n---\nHi\n",
    });
    const folder = await temporaryFolder();
    cleanups.push(folder.cleanup);
    const context = testContext(folder.path, world.server.fetch);
    let link = "";
    const sessions: WorkspaceSession[] = [];
    const server = createKnowtariumServer(sessions, {
      version: "0.0.0",
      connect: async () =>
        startConnectAttempt({
          apiUrl: "https://api.test",
          appUrl: "https://app.test",
          cliVersion: "0.0.0",
          fetch: world.server.fetch,
          credentials: await context.credentials(),
          trust: context.trust,
          print: () => undefined,
          scheduler: fast,
          openUrl: (url) => {
            link = url;
            return Promise.resolve();
          },
          openSession: async (connection) => {
            const adapter = new MemoryCacheAdapter();
            const session = await WorkspaceSession.open(connection, {
              fetch: world.server.fetch,
              trust: context.trust,
              cache: new EncryptedCache(adapter),
              adapter,
              log: () => undefined,
              apiRetry: { maxAttempts: 1 },
            });
            await session.start();
            return session;
          },
        }),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-ai", version: "1.0.0" });
    let toolListChanged = 0;
    client.fallbackNotificationHandler = (notification) => {
      if (notification.method === "notifications/tools/list_changed") toolListChanged++;
      return Promise.resolve();
    };
    await client.connect(clientSide);
    cleanups.push(async () => {
      for (const session of sessions) session.stop();
      await client.close();
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const [content] = result.content as { text: string }[];
      return { error: result.isError === true, text: content?.text ?? "" };
    };

    const tools = async () => (await client.listTools()).tools.map((tool) => tool.name);
    expect(await tools()).toContain("connect");
    expect(await tools()).not.toContain("propose_edit");
    const before = await call("list_notes");
    expect(before.error).toBe(true);
    expect(before.text).toMatch(/connect/);

    const started = JSON.parse((await call("connect")).text) as { status: string; url: string };
    expect(started).toMatchObject({ status: "waiting" });
    expect(started.url).toBe(link);
    expect(JSON.parse((await call("connect")).text)).toMatchObject({ status: "waiting" });

    await approveInBrowser(world, link);
    while (sessions.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await tools()).toContain("propose_edit");
    expect(await tools()).not.toContain("connect");
    expect(toolListChanged).toBeGreaterThan(0);
    const listed = JSON.parse((await call("list_notes")).text) as { notes: { name: string }[] };
    expect(listed.notes.map((note) => note.name)).toEqual(["hello.md"]);
    expect(await (await context.credentials()).list()).toHaveLength(1);
  });
});
