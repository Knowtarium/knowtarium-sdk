import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { join } from "node:path";

import { ready, toBase64Url } from "../../crypto/index.js";
import { World } from "../../client/testing/world.js";
import { createApiClient } from "../../client/index.js";
import { routes } from "../../protocol/index.js";
import { runCli } from "../run.js";
import { mcpUpdateMessage } from "../update.js";
import { makeCliContext } from "../context.js";
import { cliEnvironment } from "../env.js";
import { TestIo, temporaryFolder, testContext } from "../testing/context.js";
import { validateFolder } from "./validate.js";

beforeAll(ready);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * A connected CLI; `outdated` speaks a protocol version the API no longer supports, `behind` talks
 * to an API that supports only older ones. `direct`: connected since direct writes (its own
 * signing key, which the owner vouched for).
 */
async function connected(
  api: "online" | "offline" | "outdated" | "behind" = "online",
  options: { direct?: boolean } = {},
) {
  const world = new World();
  const folder = await temporaryFolder();
  cleanup = folder.cleanup;
  const fetch: typeof world.server.fetch =
    api === "offline"
      ? () => Promise.reject(new TypeError("fetch failed"))
      : api === "outdated"
        ? (url, init) =>
            world.server.fetch(url, {
              ...init,
              headers: { ...init.headers, "Knowtarium-Protocol-Version": "99" },
            })
        : api === "behind"
          ? () =>
              Promise.resolve(
                jsonAnswer(400, {
                  error: {
                    code: "unsupported_protocol",
                    message: "Unsupported protocol version",
                    supportedVersions: [1],
                  },
                }),
              )
          : world.server.fetch;
  const context = testContext(folder.path, fetch);
  const vouched = world.server.agentKeyRecords[0];
  await (
    await context.credentials()
  ).put({
    apiUrl: "https://api.test",
    workspaceId: world.workspaceId,
    tokenId: world.tokenId,
    tokenSecret: world.agentToken,
    access: "read-write",
    folderIds: [],
    agentPrivateKey: toBase64Url(world.agent.privateKey),
    ownerId: world.accountId,
    ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
    connectedAt: new Date().toISOString(),
    ...(options.direct === true && vouched !== undefined
      ? {
          agentSignPrivateKey: toBase64Url(world.agentSigning.privateKey),
          agentKey: vouched.signed,
        }
      : {}),
  });
  const run = (...argv: string[]) =>
    runCli(argv, () => Promise.resolve(context), context.io, "0.0.0");
  return { world, context, run, folder: folder.path };
}

describe("commands", () => {
  it("prints help and refuses unknown commands", async () => {
    const { context, run } = await connected();
    expect(await run()).toBe(0);
    expect(context.io.lines[0]).toMatch(/^knowtarium: /);
    expect(await run("nope")).toBe(2);
    expect(await run("status", "--bogus")).toBe(2);
    expect(await run("agents", "--agent", "cursor", "--agent", "nope")).toBe(2);
    expect(context.io.errors.at(-1)).toContain('unknown agent "nope"');
  });

  it("prints a command's own usage with --help", async () => {
    const { context, run } = await connected();
    expect(await run("status", "--help")).toBe(0);
    expect(context.io.lines.at(-1)).toMatch(/^Usage:\n {2}knowtarium status \[--offline\]/);
    expect(context.io.lines.at(-1)).not.toContain("knowtarium convert");
    expect(await run("login", "-h")).toBe(0);
    expect(context.io.lines.at(-1)).toContain("knowtarium connect");
  });

  it("says plainly when Knowtarium can't be reached, and when a folder doesn't exist", async () => {
    const { context, run, folder } = await connected("offline");
    expect(await run("status")).toBe(0);
    expect(context.io.lines.join("\n")).toMatch(/can't be reached right now/);
    expect(context.io.lines.join("\n")).toContain("(unreachable)");
    expect(await run("connect", "--no-agents")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/can't be reached at https:\/\/api\.test/);
    expect(await run("validate", join(folder, "nowhere"))).toBe(2);
    expect(context.io.errors.at(-1)).toMatch(/There is no folder/);
  });

  it("shows the connection and whether its token still works", async () => {
    const { world, context, run } = await connected();
    expect(await run("status", "--json")).toBe(0);
    const report = JSON.parse(context.io.lines.at(-1) ?? "{}") as {
      connections: { token: string; workspaceId: string }[];
    };
    expect(report.connections).toMatchObject([{ workspaceId: world.workspaceId, token: "active" }]);
    world.server.tokenRevoked = true;
    expect(await run("status")).toBe(1);
    expect(context.io.lines.join("\n")).toContain("(revoked)");
    // and how to remove the connection, or connect it again
    expect(context.io.lines.join("\n")).toContain(
      `run \`npx knowtarium disconnect --workspace ${world.workspaceId}\` to remove it`,
    );
  });

  it("disconnects: revokes the token and wipes the local keys and cache", async () => {
    const { world, context, run } = await connected();
    await context.cache.setCursor(world.workspaceId, 7);
    await context.trust.pinOwnerKey(
      world.workspaceId,
      toBase64Url(world.account.signing.publicKey),
    );
    expect(await run("disconnect")).toBe(0);
    expect(world.server.tokenRevoked).toBe(true);
    expect(await (await context.credentials()).list()).toEqual([]);
    expect(await context.cache.cursor(world.workspaceId)).toBe(0);
    expect(await context.trust.ownerKey(world.workspaceId)).toBeUndefined();
    expect(context.memorySecrets.values.size).toBe(0);
    expect(await run("disconnect")).toBe(1);
  });
});

describe("how the agent's changes land", () => {
  it("shows in status whether changes are written directly or proposed", async () => {
    const { world, context, run } = await connected("online", { direct: true });
    expect(await run("status")).toBe(0);
    expect(context.io.lines).toContain("  changes   read and write");
    // the owner asks for approval of agent changes
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    expect(await run("status", "--json")).toBe(0);
    const report = JSON.parse(context.io.lines.at(-1) ?? "{}") as {
      connections: { agentChanges: unknown }[];
    };
    expect(report.connections[0]?.agentChanges).toEqual({
      writes: "direct",
      default: "review",
      reviewFolders: 0,
      directFolders: 0,
    });
    expect(await run("status")).toBe(0);
    expect(context.io.lines).toContain("  changes   read; changes need approval");
    expect(await run("status", "--offline")).toBe(0);
    expect(context.io.lines).toContain(
      "  changes   unknown offline (`knowtarium status` online shows it)",
    );
  });

  it("says a connection made before direct writes only proposes, and how to change that", async () => {
    const { context, run } = await connected();
    expect(await run("status")).toBe(0);
    expect(context.io.lines).toContain("  changes   read, and propose changes for approval");
    expect(context.io.lines.join("\n")).toMatch(
      /run `npx knowtarium connect` again from your home folder, then restart your agents/,
    );
  });
});

describe("a server behind this knowtarium", () => {
  it("says the server is behind instead of asking to update the CLI", async () => {
    const { context, run } = await connected("behind");
    expect(await run("status")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/server .* is behind, not this CLI/);
    expect(context.io.errors.at(-1)).not.toMatch(/Please update/);
    expect(mcpUpdateMessage(await statusError(context))).toMatch(/the server is behind/);
  });
});

describe("a knowtarium too old for Knowtarium", () => {
  it("says to update instead of showing a protocol error", async () => {
    const { context, run } = await connected("outdated");
    expect(await run("status")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(
      /^Please update knowtarium: this version \(0\.0\.0\) is older than Knowtarium supports/,
    );
    expect(context.io.errors.at(-1)).toContain("npx knowtarium@latest agents");
    expect(await run("connect", "--no-agents")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/^Please update knowtarium/);
    expect(await run("disconnect")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/^Please update knowtarium.*web app's settings\.$/);
  });
});

describe("commands that never open the secret store", () => {
  it("runs help, validate and status --offline without touching the keychain", async () => {
    const world = new World();
    const folder = await temporaryFolder();
    cleanup = folder.cleanup;
    const io = new TestIo();
    const base = testContext(folder.path, world.server.fetch, io);
    const context = makeCliContext({
      env: base.env,
      io,
      fetch: world.server.fetch,
      version: "0.0.0",
      openSecrets: () => Promise.reject(new Error("the secret store was opened")),
    });
    const run = (...argv: string[]) => runCli(argv, () => Promise.resolve(context), io, "0.0.0");
    expect(await run("help")).toBe(0);
    expect(await run("validate", "test/fixtures/import/okf-plain")).toBe(0);
    expect(await run("status", "--offline")).toBe(0);
    expect(io.errors).toEqual([]);
  });
});

describe("validate", () => {
  it("passes a plain OKF bundle and flags a vault that isn't migrated", async () => {
    expect(await validateFolder("test/fixtures/import/okf-plain")).toEqual([]);
    const findings = await validateFolder("test/fixtures/import/obsidian-messy");
    expect(
      findings.filter((finding) => finding.level === "error").map((finding) => finding.path),
    ).toContain("Welcome.md");
    expect(findings.some((finding) => finding.message.includes("no root index.md"))).toBe(true);
  });
});

describe("the environment", () => {
  it("takes https URLs, and plain http only to this computer", () => {
    const urls = (api: string, app = "https://app.test") =>
      cliEnvironment({ KNOWTARIUM_API_URL: api, KNOWTARIUM_APP_URL: app }, "linux", "/home/maya");
    expect(urls("https://api.example.com/").apiUrl).toBe("https://api.example.com");
    expect(urls("http://localhost:8787").apiUrl).toBe("http://localhost:8787");
    expect(urls("http://127.0.0.1:8787", "http://localhost:3000").appUrl).toBe(
      "http://localhost:3000",
    );
    expect(() => urls("http://api.example.com")).toThrow(/KNOWTARIUM_API_URL must be an https/);
    expect(() => urls("https://api.test", "http://192.168.1.2")).toThrow(/KNOWTARIUM_APP_URL/);
    expect(() => urls("ftp://api.test")).toThrow(/https/);
    expect(() => urls("not a url")).toThrow(/isn't a URL/);
  });
});

/** The error the API answers a status check with, as the MCP server would get it. */
async function statusError(context: Awaited<ReturnType<typeof connected>>["context"]) {
  const [connection] = await (await context.credentials()).list();
  const api = createApiClient({
    baseUrl: "https://api.test",
    fetch: context.fetch,
    auth: { kind: "agent", token: connection?.tokenSecret ?? "" },
    retry: { maxAttempts: 1 },
  });
  return api.call(routes.getCurrentToken).then(
    () => null,
    (error: unknown) => error,
  );
}

/** A JSON answer as the sync API would send it. */
function jsonAnswer(status: number, body: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}
