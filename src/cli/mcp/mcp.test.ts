import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { addVerified, parseNote, readProvenance } from "../../core/index.js";
import {
  createAgentSigningKeyPair,
  ready,
  type SigningKeyPair,
  toBase64Url,
} from "../../crypto/index.js";
import { type FolderId, type NoteId, routes } from "../../protocol/index.js";
import {
  EncryptedCache,
  MemoryTrustStorage,
  newId,
  prepareFolder,
  TrustState,
} from "../../client/index.js";
import { World } from "../../client/testing/world.js";
import { FileCacheAdapter } from "../storage/file-cache.js";
import { GuardedCacheAdapter } from "./guarded-cache.js";
import type { Connection } from "../storage/credentials.js";
import { temporaryFolder } from "../testing/context.js";
import { readFile } from "node:fs/promises";

import { CONVENTIONS_SKILL } from "./conventions.js";
import { CONVENTIONS_URI, createKnowtariumServer, INSTRUCTIONS } from "./server.js";
import { type SessionDeps, WorkspaceSession } from "./session.js";

beforeAll(ready);

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // last in, first out: clients and sessions stop before their folders are removed
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const note = (title: string, body: string, extra = "") =>
  `---\ntype: Note\ntitle: ${title}\n${extra}generated: { by: claude-code/2.0, at: 2026-09-01T10:00:00Z }\n---\n${body}\n`;

/** A workspace with two folders and three notes, written by the owner in the web app. */
async function seeded() {
  const world = new World();
  const web = world.web();
  const folder = async (name: string): Promise<FolderId> => {
    const request = prepareFolder(world.signer, world.key, {
      workspaceId: world.workspaceId,
      parentId: null,
      name,
      rootFolderId: null,
    });
    await web.api.call(routes.createFolder, {
      params: { workspaceId: world.workspaceId },
      body: request,
    });
    return request.id;
  };
  const research = await folder("Research");
  const archive = await folder("Archive");
  const ids = { pricing: newId("note"), annual: newId("note"), old: newId("note") };
  const write = (noteId: NoteId, folderId: FolderId, name: string, text: string) =>
    web.engine.writeNote({ noteId, folderId, baseVersion: 0, name, text });
  await write(
    ids.pricing,
    research,
    "pricing.md",
    note(
      "Pricing",
      "Pro is 14 EUR a month. See [[Annual plans]].",
      "description: Current prices\n",
    ),
  );
  await write(
    ids.annual,
    research,
    "annual-plans.md",
    note("Annual plans", "Yearly billing saves two months."),
  );
  await write(ids.old, archive, "old-pricing.md", note("Old pricing", "Pro was 12 EUR a month."));
  return { world, web, research, archive, ids };
}

/**
 * The owner sets the workspace's agent policy in the web app: `review` asks for approval of
 * agent changes (everywhere, or in `folders`), `direct` lets them apply.
 */
async function setPolicy(
  seed: { world: World; web: ReturnType<World["web"]> },
  mode: "direct" | "review",
  folders: { folderId: FolderId; mode: "direct" | "review" }[] = [],
) {
  const result = await seed.web.engine.setAgentPolicy({
    default: mode,
    folders,
    baseRevision: seed.world.server.agentPolicy.revision,
  });
  expect(result.status).toBe("saved");
}

/** The CLI side: a session over a temporary cache, an MCP server, and a client talking to it. */
async function connect(
  world: World,
  options: {
    access?: "read" | "read-write";
    folderIds?: FolderId[];
    fetch?: typeof world.server.fetch;
    cacheRoot?: string;
    /** Whether to wait for the session's first sync before connecting the client. */
    wait?: boolean;
    stillConnected?: () => Promise<boolean>;
    /** Retry settings (by default retries wait an hour, so they never run in a test). */
    retry?: Pick<
      SessionDeps,
      "retryAfterMs" | "maxRetryAfterMs" | "retryWaitMs" | "retryOnCallMinMs"
    >;
    /**
     * A connection made since direct writes: its own signing key (the world's, which the owner
     * vouched for, unless another is given) and the owner's `agent_key`. Without it, a connection
     * made before, which only proposes.
     */
    direct?: boolean | { signing: SigningKeyPair };
  } = {},
) {
  const folder = await temporaryFolder();
  cleanups.push(folder.cleanup);
  const cacheRoot = options.cacheRoot ?? folder.path;
  // the server enforces the token's folders, as the sync API does
  world.server.agentFolderIds = options.folderIds ?? [];
  const connection: Connection = {
    apiUrl: "https://api.test",
    workspaceId: world.workspaceId,
    tokenId: world.tokenId,
    tokenSecret: world.agentToken,
    access: options.access ?? "read-write",
    folderIds: options.folderIds ?? [],
    agentPrivateKey: toBase64Url(world.agent.privateKey),
    ownerId: world.accountId,
    ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
    connectedAt: new Date().toISOString(),
  };
  if (options.direct !== undefined && options.direct !== false) {
    const signing = options.direct === true ? world.agentSigning : options.direct.signing;
    const [vouched] = world.server.agentKeyRecords;
    connection.agentSignPrivateKey = toBase64Url(signing.privateKey);
    if (vouched !== undefined) connection.agentKey = vouched.signed;
  }
  const logs: string[] = [];
  const adapter = new GuardedCacheAdapter(new FileCacheAdapter(cacheRoot));
  const session = await WorkspaceSession.open(connection, {
    fetch: options.fetch ?? world.server.fetch,
    trust: new TrustState(new MemoryTrustStorage()),
    cache: new EncryptedCache(adapter),
    adapter,
    log: (line) => logs.push(line),
    retryAfterMs: 3_600_000,
    ...options.retry,
    apiRetry: { maxAttempts: 1 },
    ...(options.stillConnected === undefined
      ? {}
      : {
          stillConnected: options.stillConnected,
          onDisconnected: () => {
            adapter.stop(connection.workspaceId);
          },
        }),
  });
  const started = session.start();
  if (options.wait !== false) await started;
  cleanups.push(() => {
    session.stop();
    return Promise.resolve();
  });
  const { client, call } = await serve([session]);
  return { session, client, call, logs, cacheRoot, started };
}

/** An MCP server over sessions, and a client talking to it. */
async function serve(sessions: WorkspaceSession[], notConnected?: string) {
  const server = createKnowtariumServer(sessions, {
    version: "0.0.0",
    ...(notConnected === undefined ? {} : { notConnected }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [content, notice] = result.content as { type: string; text: string }[];
    return {
      error: result.isError === true,
      text: content?.text ?? "",
      notice: notice?.text ?? null,
      json: () => JSON.parse(content?.text ?? "null") as unknown,
    };
  };
  return { client, call };
}

describe("the MCP server", () => {
  it("lists the tools, hiding writes from a read-only token", async () => {
    const { world } = await seeded();
    const writer = await connect(world);
    const names = (await writer.client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "create_note",
      "flag_conflict",
      "get_conventions",
      "list_comments",
      "list_folders",
      "list_notes",
      "list_pending_checks",
      "list_stale",
      "list_workspaces",
      "my_pending_changes",
      "note_history",
      "propose_edit",
      "read_note",
      "record_check",
      "related_notes",
      "reply_comment",
      "resolve_link",
      "search_notes",
    ]);
    const reader = await connect(world, { access: "read" });
    const readNames = (await reader.client.listTools()).tools.map((tool) => tool.name);
    expect(readNames).not.toContain("propose_edit");
    expect(readNames).toContain("search_notes");
  });

  it("serves the conventions skill to every client, connected or not", async () => {
    const skill = await readFile(
      new URL("../../../skills/knowtarium-conventions/SKILL.md", import.meta.url),
      "utf8",
    );
    // src/cli/mcp/conventions.ts is generated from the skill: run scripts/sync-conventions.js
    expect(CONVENTIONS_SKILL).toBe(skill);
    expect(INSTRUCTIONS).toMatch(/Call get_conventions first/);
    const { client, call } = await serve([]);
    const answer = await call("get_conventions");
    expect(answer.error).toBe(false);
    expect(answer.text).toBe(skill);
    const prompt = await client.getPrompt({ name: "knowtarium-conventions" });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text", text: skill });
    const resource = await client.readResource({ uri: CONVENTIONS_URI });
    expect(resource.contents[0]).toMatchObject({ mimeType: "text/markdown", text: skill });
  });

  it("answers the reading tools from the decrypted notes", async () => {
    const { world, ids } = await seeded();
    const { call } = await connect(world);
    expect((await call("list_workspaces")).json()).toMatchObject([
      { id: world.workspaceId, name: "Clients", notes: 3 },
    ]);
    expect((await call("list_folders")).json()).toMatchObject([
      { path: "Archive" },
      { path: "Research" },
    ]);
    const { notes: hits } = (await call("search_notes", { query: "pro month" })).json() as {
      notes: { title: string }[];
    };
    expect(hits.map((hit) => hit.title).sort()).toEqual(["Old pricing", "Pricing"]);
    const read = (await call("read_note", { note: "Research/pricing.md" })).json() as Record<
      string,
      unknown
    >;
    expect(read).toMatchObject({
      id: ids.pricing,
      title: "Pricing",
      description: "Current prices",
      version: 1,
      name: "pricing.md",
      links: [{ link: "[[Annual plans]]", to: "Research/annual-plans.md" }],
    });
    expect(read["text"]).toContain("Pro is 14 EUR a month.");
    expect((await call("related_notes", { note: ids.pricing })).json()).toMatchObject([
      { title: "Annual plans" },
    ]);
    expect((await call("resolve_link", { link: "[[Nothing]]" })).json()).toEqual({
      status: "ghost",
    });
    const history = (await call("note_history", { note: ids.pricing })).json() as {
      entries: unknown[];
    };
    expect(history.entries).toMatchObject([{ kind: "version", version: 1, signature: "verified" }]);
  });

  it("proposes edits and new notes as pending changes, marked as the agent's", async () => {
    const { world, ids, research } = await seeded();
    const { call } = await connect(world);
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    const edited = read.text.replace("14 EUR", "16 EUR");
    const unbased = await call("propose_edit", { note: ids.pricing, text: edited });
    expect(unbased.error).toBe(true);
    const answer = await call("propose_edit", {
      note: ids.pricing,
      text: edited,
      base_version: 1,
      summary: "New price",
    });
    const proposal = answer.json() as {
      pendingId: string;
    };
    const pending = world.server.pending.get(proposal.pendingId as never);
    expect(pending?.change).toMatchObject({ noteId: ids.pricing, baseVersion: 1, status: "open" });

    const review = await world.web().engine.readPending(proposal.pendingId as never);
    expect(review.proposed).toContain("16 EUR");
    const provenance = readProvenance(parseNote(review.proposed).frontmatter?.data ?? {});
    expect(provenance.generated?.by).toBe("claude-code/2.1.0");
    expect(provenance.verified.at(-1)?.by).toBe("claude-code/2.1.0");

    const created = await call("create_note", {
      folder: "Research",
      title: "Discounts",
      text: "Students get 50% off.",
    });
    expect(created.error).toBe(false);
    const pendingAnswer = await call("my_pending_changes", { limit: 1 });
    expect(pendingAnswer.json()).toMatchObject({
      total: 2,
      truncated: true,
      next_offset: 1,
      changes: [{ status: "open" }],
    });
    const root = await call("create_note", { folder: "/", title: "X", text: "x" });
    expect(root).toMatchObject({ error: true });
    expect(root.text).toMatch(/no root folder/);

    // file names: given, defaulted from the title, refused when taken or invalid, renamed
    const named = (
      await call("create_note", {
        folder: "Research",
        name: "student-discounts.md",
        title: "Student discounts",
        text: "Half price.",
      })
    ).json() as { pendingId: string; name: string };
    expect(named.name).toBe("student-discounts.md");
    expect((await world.web().engine.readPending(named.pendingId as never)).proposedName).toBe(
      "student-discounts.md",
    );
    const taken = await call("create_note", {
      folder: "Research",
      name: "pricing.md",
      title: "Again",
      text: "x",
    });
    expect(taken.error).toBe(true);
    expect(taken.text).toMatch(/exists already/);
    expect(
      (await call("create_note", { folder: "Research", name: "../x.md", title: "X", text: "x" }))
        .error,
    ).toBe(true);
    // a second open proposal for the same note needs allow_duplicate
    const again = await call("propose_edit", {
      note: ids.pricing,
      text: read.text,
      base_version: 1,
      name: "prices.md",
    });
    expect(again.error).toBe(true);
    expect(again.text).toMatch(/open proposal for this note already/);
    const rename = (
      await call("propose_edit", {
        note: ids.pricing,
        text: read.text,
        base_version: 1,
        name: "prices.md",
        allow_duplicate: true,
      })
    ).json() as { pendingId: string };
    const renamed = await world.web().engine.readPending(rename.pendingId as never);
    expect([renamed.base?.name, renamed.proposedName]).toEqual(["pricing.md", "prices.md"]);
    expect(research).toBeDefined();
  });

  it("refuses a human check from an agent, invalid frontmatter and stale bases", async () => {
    const { world, web, ids, research } = await seeded();
    const { call } = await connect(world);
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    const forged = read.text
      .replace("---\nPro", "---\nPro")
      .replace(
        "generated:",
        "verified:\n  - { by: human:someone, at: 2026-10-01T00:00:00Z }\ngenerated:",
      );
    const refused = await call("propose_edit", {
      note: ids.pricing,
      text: forged,
      base_version: 1,
    });
    expect(refused).toMatchObject({ error: true });
    expect(refused.text).toMatch(/human:/);
    expect(
      (
        await call("propose_edit", {
          note: ids.pricing,
          text: "---\ntitle: [x\n---\nbody",
          base_version: 1,
        })
      ).error,
    ).toBe(true);

    await web.engine.writeNote({
      noteId: ids.pricing,
      folderId: research,
      baseVersion: 1,
      name: "pricing.md",
      text: read.text.replace("14", "15"),
    });
    const stale = await call("propose_edit", {
      note: ids.pricing,
      text: read.text,
      base_version: 1,
    });
    expect(stale.error).toBe(true);
    expect(stale.text).toMatch(/version 2/);
    expect(stale.text).toMatch(/Read it again/);
    expect(stale.text).not.toMatch(/propose/);
  });

  it("keeps a folder-scoped agent inside its folders", async () => {
    const { world, ids, research } = await seeded();
    const { call } = await connect(world, { folderIds: [research] });
    const { notes } = (await call("list_notes")).json() as { notes: { id: string }[] };
    expect(notes.map((entry) => entry.id).sort()).toEqual([ids.annual, ids.pricing].sort());
    expect((await call("read_note", { note: ids.old })).error).toBe(true);
    const outside = await call("create_note", { folder: "Archive", title: "X", text: "x" });
    expect(outside.error).toBe(true);
  });

  it("runs the check loop: pending checks with their diff, then record_check and comments", async () => {
    const seed = await seeded();
    const { world, ids } = seed;
    // the workspace asks for approval, so a person's edit waits for an agent check
    await setPolicy(seed, "review");
    await personEdits(seed);

    const { call } = await connect(world);
    const { notes: waiting } = (await call("list_pending_checks")).json() as {
      notes: { id: string; diff: string }[];
    };
    expect(waiting.map((entry) => entry.id)).toEqual([ids.annual]);
    expect(waiting[0]?.diff).toContain("+ Yearly billing saves three months.");
    expect(waiting[0]?.diff).toContain("- Yearly billing saves two months.");

    expect(
      (await call("record_check", { note: ids.annual, result: "pass", scope: ["nope"] })).text,
    ).toMatch(/No note nope/);
    await call("read_note", { note: ids.pricing });
    const recorded = (
      await call("record_check", { note: ids.annual, result: "pass", scope: [ids.pricing] })
    ).json() as {
      checkId: string;
      state: string;
    };
    expect(world.server.checks.map((check) => check.id)).toEqual([recorded.checkId]);
    // the unapplied pass counts at once: the note no longer waits for a check
    expect(recorded.state).toBe("fully-verified");
    expect((await call("list_pending_checks")).json()).toMatchObject({ total: 0 });
    // checked now: another check of it is refused
    const again = await call("record_check", {
      note: ids.annual,
      result: "fail",
      scope: [ids.pricing],
    });
    expect(again.error).toBe(true);
    expect(again.text).toMatch(/isn't waiting for a check/);
    expect(
      (await call("flag_conflict", { note: ids.pricing, text: "x", conflicts_with: ["Nowhere"] }))
        .error,
    ).toBe(true);

    const flag = (
      await call("flag_conflict", {
        note: ids.pricing,
        text: "Annual plans now says three months.",
        conflicts_with: [ids.annual],
      })
    ).json() as { commentId: string };
    await call("reply_comment", {
      note: ids.pricing,
      comment_id: flag.commentId,
      text: "Proposing a fix.",
    });
    const { threads } = (await call("list_comments", { note: ids.pricing })).json() as {
      threads: unknown[];
    };
    expect(threads).toMatchObject([{ conflict: true, replies: [{ text: "Proposing a fix." }] }]);
    // every note in scope at once
    expect((await call("list_comments")).json()).toMatchObject({
      total: 1,
      threads: [{ noteId: ids.pricing, status: "open" }],
    });
  });

  it("answers from the encrypted cache when the API is unreachable, and keeps no plaintext there", async () => {
    const { world } = await seeded();
    const first = await connect(world);
    const files = await import("node:fs/promises");
    const entries = await files.readdir(first.cacheRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile())) {
      const bytes = await files.readFile(`${entry.parentPath}/${entry.name}`);
      expect(bytes.toString("latin1")).not.toContain("14 EUR");
    }
    expect(entries.some((entry) => entry.name === "search-index")).toBe(true);

    // nothing reaches the API, /keys included: the cached signed key records open the cache
    const requests: string[] = [];
    const offline = await connect(world, {
      cacheRoot: first.cacheRoot,
      fetch: (url) => {
        requests.push(url);
        return Promise.reject(new TypeError("offline"));
      },
    });
    expect(requests.some((url) => url.endsWith("/keys"))).toBe(true);
    expect(offline.session.status).toBe("offline");
    expect(offline.logs.join("\n")).toMatch(/can't be reached/);
    const answer = await offline.call("search_notes", { query: "yearly" });
    const { notes: hits } = answer.json() as { notes: { title: string }[] };
    expect(hits.map((hit) => hit.title)).toEqual(["Annual plans"]);
    expect(answer.notice).toMatch(/can't be reached/);

    // a warm start doesn't wait for the network: an API that never answers still leaves the
    // cached copy answering at once (the keys come from the verified cached records)
    const hanging = await connect(world, {
      cacheRoot: first.cacheRoot,
      fetch: () => new Promise(() => undefined),
      wait: false,
    });
    const deadline = Date.now() + 2_000;
    while (!hanging.session.loaded && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hanging.session.loaded).toBe(true);
    const quick = await hanging.call("search_notes", { query: "yearly" });
    expect(quick.error).toBe(false);

    // a cold cache offline: a clear error, not an empty answer
    const cold = await connect(world, {
      fetch: () => Promise.reject(new TypeError("offline")),
    });
    const refused = await cold.call("list_notes");
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/no local copy/);
  });
});

describe("a server too old for Knowtarium", () => {
  it("tells the agent to have knowtarium updated, for the session and for every tool", async () => {
    const { world } = await seeded();
    const outdated = await connect(world, {
      fetch: (url, init) =>
        world.server.fetch(url, {
          ...init,
          headers: { ...init.headers, "Knowtarium-Protocol-Version": "99" },
        }),
    });
    expect(outdated.session.status).toBe("failed");
    expect(outdated.session.problem).toMatch(/^Please update knowtarium/);
    const answer = await outdated.call("list_notes");
    expect(`${answer.text}\n${answer.notice ?? ""}`).toMatch(/Please update knowtarium/);
    expect(`${answer.text}\n${answer.notice ?? ""}`).toContain("npx knowtarium@latest agents");
  });
});

describe("a workspace whose sync failed", () => {
  /** The API, with version batches answered by something invalid while `broken` is set. */
  function flaky(world: World) {
    const state = { broken: true, attempts: 0, times: [] as number[] };
    const fetch: typeof world.server.fetch = (url, init) => {
      if (!url.includes("/version-batches")) return world.server.fetch(url, init);
      state.attempts++;
      state.times.push(performance.now());
      if (!state.broken) return world.server.fetch(url, init);
      return Promise.resolve({
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode("{}").buffer),
      });
    };
    return { state, fetch };
  }

  const until = async (done: () => boolean) => {
    for (let waited = 0; !done(); waited += 10) {
      if (waited > 5_000) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("tries again on the next tool call, and the error goes once it works", async () => {
    const { world } = await seeded();
    const api = flaky(world);
    const session = await connect(world, { fetch: api.fetch, retry: { retryOnCallMinMs: 0 } });
    expect(session.session.status).toBe("failed");
    expect(session.session.problem).toMatch(/Trying again automatically/);
    // still failing: the call says why, from the retry it started
    const refused = await session.call("list_notes");
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/Trying again automatically/);
    expect(api.state.attempts).toBe(2);

    api.state.broken = false;
    const answer = await session.call("list_notes");
    expect(answer.error).toBe(false);
    expect(answer.notice).toBeNull();
    expect(session.session.status).toBe("ready");
    expect(session.session.problem).toBeNull();
  });

  it("retries on its own with a growing wait, until it works", async () => {
    const { world } = await seeded();
    const api = flaky(world);
    const session = await connect(world, {
      fetch: api.fetch,
      retry: { retryAfterMs: 20, maxRetryAfterMs: 80 },
    });
    await until(() => api.state.attempts >= 4);
    expect(session.session.status).not.toBe("ready");
    // waits of 20, 40, then 80 ms (the cap); timers never fire early, though they may fire late
    const gaps = api.state.times
      .slice(1, 4)
      .map((time, index) => time - (api.state.times[index] ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(18);
    expect(gaps[1]).toBeGreaterThanOrEqual(38);
    expect(gaps[2]).toBeGreaterThanOrEqual(78);
    api.state.broken = false;
    await until(() => session.session.status === "ready");
    expect(session.session.problem).toBeNull();
    expect((await session.call("list_notes")).error).toBe(false);
  });

  it("doesn't retry on every call: at most once per retryOnCallMinMs", async () => {
    const { world } = await seeded();
    const api = flaky(world);
    const session = await connect(world, { fetch: api.fetch, retry: { retryOnCallMinMs: 60_000 } });
    await session.call("list_notes");
    await session.call("list_notes");
    expect(api.state.attempts).toBe(1);
    expect(session.session.status).toBe("failed");
  });
});

describe("the MCP server's states", () => {
  it("says when nothing is connected, the access was revoked or the workspace disconnected", async () => {
    const empty = await serve([]);
    const none = await empty.call("list_workspaces");
    expect(none).toMatchObject({ error: true });
    expect(none.text).toMatch(/npx knowtarium connect/);

    const { world } = await seeded();
    world.server.tokenRevoked = true;
    const revoked = await connect(world);
    expect(revoked.session.status).toBe("revoked");
    const answer = await revoked.call("list_notes");
    expect(answer).toMatchObject({ error: true });
    expect(answer.text).toMatch(/revoked/);

    world.server.tokenRevoked = false;
    let saved = true;
    const live = await connect(world, { stillConnected: () => Promise.resolve(saved) });
    expect((await live.call("list_notes")).error).toBe(false);
    saved = false;
    const gone = await live.call("list_notes");
    expect(gone).toMatchObject({ error: true });
    expect(gone.text).toMatch(/disconnected/);
    expect(live.session.status).toBe("disconnected");
  });

  it("keeps serving the other workspaces when one fails", async () => {
    const good = await seeded();
    const bad = await seeded();
    bad.world.server.tokenRevoked = true;
    const a = await connect(good.world);
    const b = await connect(bad.world);
    const { call } = await serve([a.session, b.session]);
    expect((await call("list_workspaces")).json()).toMatchObject([
      { id: good.world.workspaceId, status: "ready" },
      { id: bad.world.workspaceId, status: "revoked" },
    ]);
    expect((await call("list_notes", { workspace: good.world.workspaceId })).error).toBe(false);
    expect((await call("list_notes", { workspace: bad.world.workspaceId })).error).toBe(true);
  });

  it("uses the one workspace that can be used when another's access was revoked", async () => {
    const good = await seeded();
    const bad = await seeded();
    const a = await connect(good.world);
    // revoked after a sync, so its local copy (and its name, the same as the other's) remains
    const warm = await connect(bad.world);
    bad.world.server.tokenRevoked = true;
    const b = await connect(bad.world, { cacheRoot: warm.cacheRoot });
    expect(b.session.status).toBe("revoked");
    const { call } = await serve([a.session, b.session]);
    const listed = (await call("list_notes")).json() as { total: number };
    expect(listed.total).toBe(3);
    expect((await call("list_folders")).json()).toMatchObject([
      { path: "Archive" },
      { path: "Research" },
    ]);
    // list_workspaces says what is wrong with the other one, and how the person removes it
    const workspaces = (await call("list_workspaces")).json() as {
      status: string;
      problem: string;
    }[];
    expect(workspaces).toMatchObject([
      { id: good.world.workspaceId, status: "ready" },
      { id: bad.world.workspaceId, name: "Clients", notes: 3, status: "revoked" },
    ]);
    expect(workspaces[1]?.problem).toContain(
      `npx knowtarium disconnect --workspace ${bad.world.workspaceId}`,
    );
    // its own ID still reaches it, to hear why it can't answer
    const named = await call("list_notes", { workspace: bad.world.workspaceId });
    expect(named.error).toBe(true);
    expect(named.text).toContain(`npx knowtarium disconnect --workspace ${bad.world.workspaceId}`);
    // a name both have is never guessed: both IDs, with their states
    const ambiguous = await call("list_notes", { workspace: "clients" });
    expect(ambiguous.error).toBe(true);
    expect(ambiguous.text).toMatch(/2 connected workspaces are called clients/);
    expect(ambiguous.text).toContain(`${good.world.workspaceId} ("Clients"), ready`);
    expect(ambiguous.text).toContain(`${bad.world.workspaceId} ("Clients"), access revoked`);
  });

  it("waits for a workspace's first sync to learn that its access was revoked", async () => {
    const good = await seeded();
    const bad = await seeded();
    bad.world.server.tokenRevoked = true;
    const a = await connect(good.world);
    const slow: typeof bad.world.server.fetch = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return bad.world.server.fetch(url, init);
    };
    const b = await connect(bad.world, { wait: false, fetch: slow });
    expect(b.session.status).toBe("loading");
    const { call } = await serve([a.session, b.session]);
    expect((await call("list_notes")).error).toBe(false);
    expect(b.session.status).toBe("revoked");
  });

  it("asks which workspace when several can be used, by ID; a shared name is refused", async () => {
    const one = await seeded();
    const two = await seeded();
    const a = await connect(one.world);
    const b = await connect(two.world);
    const { call } = await serve([a.session, b.session]);
    const asked = await call("list_notes");
    expect(asked.error).toBe(true);
    expect(asked.text).toMatch(/Several workspaces are connected; pass `workspace`/);
    expect(asked.text).toContain(`${one.world.workspaceId} ("Clients"), ready`);
    expect(asked.text).toContain(`${two.world.workspaceId} ("Clients"), ready`);
    const shared = await call("list_notes", { workspace: "Clients" });
    expect(shared.error).toBe(true);
    expect(shared.text).toContain(one.world.workspaceId);
    expect(shared.text).toContain(two.world.workspaceId);
    expect((await call("list_notes", { workspace: two.world.workspaceId })).error).toBe(false);
    const unknown = await call("list_notes", { workspace: "Elsewhere" });
    expect(unknown.text).toMatch(/No connected workspace is called Elsewhere/);
  });

  it("leaves out a workspace disconnected meanwhile, and says so when none can be used", async () => {
    const one = await seeded();
    const two = await seeded();
    const a = await connect(one.world);
    let saved = true;
    const b = await connect(two.world, { stillConnected: () => Promise.resolve(saved) });
    const both = await serve([a.session, b.session]);
    expect((await both.call("list_notes")).error).toBe(true);
    saved = false;
    expect((await both.call("list_notes")).error).toBe(false);
    expect(b.session.status).toBe("disconnected");

    one.world.server.tokenRevoked = true;
    two.world.server.tokenRevoked = true;
    const c = await connect(one.world);
    const d = await connect(two.world);
    const { call } = await serve([c.session, d.session]);
    const none = await call("list_notes");
    expect(none.error).toBe(true);
    expect(none.text).toMatch(/None of the connected workspaces can be used/);
    expect(none.text).toContain(`npx knowtarium disconnect --workspace ${one.world.workspaceId}`);
    expect(none.text).toContain(`npx knowtarium disconnect --workspace ${two.world.workspaceId}`);
    expect(none.text).toMatch(/npx knowtarium connect/);
  });

  it("answers before the first sync ends, saying the results may be partial", async () => {
    const { world } = await seeded();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: typeof world.server.fetch = async (url, init) => {
      if (url.includes("/changes")) await gate;
      return world.server.fetch(url, init);
    };
    // a cold cache: nothing to answer from yet
    const cold = await connect(world, { wait: false, fetch: gated });
    const loading = await cold.call("list_notes");
    expect(loading).toMatchObject({ error: true });
    expect(loading.text).toMatch(/still loading/);
    // a warm cache: answers at once, flagged as possibly incomplete
    const warm = await connect(world);
    const { call, started, session } = await connect(world, {
      wait: false,
      fetch: gated,
      cacheRoot: warm.cacheRoot,
    });
    while (!session.loaded) await new Promise((resolve) => setTimeout(resolve, 5));
    const early = await call("list_notes");
    expect(early.error).toBe(false);
    expect(early.notice).toMatch(/Still syncing/);
    release();
    await Promise.all([started, cold.started]);
    const later = await call("list_notes");
    expect(later.notice).toBeNull();
    expect((later.json() as { total: number }).total).toBe(3);
  });

  it("pages lists and cuts long notes into parts", async () => {
    const { world, web, research } = await seeded();
    const long = newId("note");
    await web.engine.writeNote({
      noteId: long,
      folderId: research,
      baseVersion: 0,
      name: "long.md",
      text: note("Long", "word ".repeat(1000)),
    });
    const { call } = await connect(world);
    expect((await call("list_notes", { limit: 2 })).json()).toMatchObject({
      total: 4,
      offset: 0,
      truncated: true,
      next_offset: 2,
    });
    const first = (await call("read_note", { note: long, max_chars: 1000 })).json() as {
      text: string;
      truncated: boolean;
      next_offset: number;
      range: { length: number };
    };
    expect(first.text).toHaveLength(1000);
    expect(first.truncated).toBe(true);
    const rest = (
      await call("read_note", { note: long, offset: first.next_offset, max_chars: 100_000 })
    ).json() as { text: string; truncated: boolean };
    expect(rest.truncated).toBe(false);
    expect(first.text.length + rest.text.length).toBe(first.range.length);
  });
});

/** The owner edits the annual plans note in the web app: their change waits for an agent check. */
async function personEdits(seed: Awaited<ReturnType<typeof seeded>>) {
  const { world, web, ids, research } = seed;
  const current = (await web.engine.readNote(ids.annual)).text ?? "";
  const at = new Date().toISOString();
  await web.engine.writeNote({
    noteId: ids.annual,
    folderId: research,
    baseVersion: 1,
    name: "annual-plans.md",
    text: current
      .replace(
        "generated: { by: claude-code/2.0, at: 2026-09-01T10:00:00Z }",
        `generated: { by: human:${world.accountId}, at: ${at} }\nverified:\n  - { by: human:${world.accountId}, at: ${at} }`,
      )
      .replace("two months", "three months"),
    signedAt: at,
  });
}

describe("the MCP tools' guardrails", () => {
  it("records a check only for a note waiting for one, at its version, against notes it read", async () => {
    const seed = await seeded();
    const { world, ids } = seed;
    await setPolicy(seed, "review");
    const { call } = await connect(world);
    // nothing waits for a check yet
    const early = await call("record_check", {
      note: ids.annual,
      result: "pass",
      scope: [ids.pricing],
    });
    expect(early.text).toMatch(/isn't waiting for a check/);
    await personEdits(seed);
    const fresh = await connect(world);
    const empty = await fresh.call("record_check", { note: ids.annual, result: "pass", scope: [] });
    expect(empty.error).toBe(true);
    const old = await fresh.call("record_check", {
      note: ids.annual,
      version: 1,
      result: "pass",
      scope: [ids.pricing],
    });
    expect(old.text).toMatch(/is at version 2, not 1/);
    const unread = await fresh.call("record_check", {
      note: ids.annual,
      result: "pass",
      scope: [ids.pricing],
    });
    expect(unread.text).toMatch(/Research\/pricing\.md wasn't read with read_note/);
    await fresh.call("read_note", { note: ids.pricing });
    const recorded = await fresh.call("record_check", {
      note: ids.annual,
      result: "pass",
      scope: [ids.pricing],
    });
    expect(recorded.error).toBe(false);
  });

  it("guards proposals: dropped keys, a person's edit waiting for a check, details in my_pending_changes", async () => {
    const seed = await seeded();
    const { world, ids } = seed;
    const { call } = await connect(world);
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    const dropped = await call("propose_edit", {
      note: ids.pricing,
      text: read.text.replace("description: Current prices\n", ""),
      base_version: 1,
    });
    expect(dropped.error).toBe(true);
    expect(dropped.text).toMatch(/drops frontmatter keys the note has: description/);

    // where the workspace asks for review: exactly as before direct writes
    await setPolicy(seed, "review");
    await personEdits(seed);
    const later = await connect(world);
    const annual = (await later.call("read_note", { note: ids.annual })).json() as {
      text: string;
      version: number;
      checkState: string;
    };
    expect(annual.checkState).toBe("agent-check-pending");
    const waiting = await later.call("propose_edit", {
      note: ids.annual,
      text: annual.text.replace("three", "four"),
      base_version: annual.version,
    });
    expect(waiting.text).toMatch(/waiting for a check/);

    await later.call("propose_edit", {
      note: ids.pricing,
      text: read.text.replace("14 EUR", "15 EUR"),
      base_version: 1,
      summary: "Raise the price",
    });
    await later.call("create_note", {
      folder: "Research",
      title: "Student Discounts 2026",
      text: "Half price.",
      summary: "New discount note",
    });
    const { changes } = (await later.call("my_pending_changes")).json() as {
      changes: Record<string, unknown>[];
    };
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          note: "Research/pricing.md",
          proposedName: "pricing.md",
          title: "Pricing",
          summary: "Raise the price",
          submittedAt: expect.stringMatching(/^\d{4}-/) as unknown,
        }),
        expect.objectContaining({
          proposedName: "student-discounts-2026.md",
          title: "Student Discounts 2026",
          summary: "New discount note",
        }),
      ]),
    );
  });

  it("names notes like the web app or the folder, knows comments, and says when nothing was proposed offline", async () => {
    const { world, ids } = await seeded();
    const { call } = await connect(world);
    // a name as the web app gives it, from the title, is accepted as it is
    const upper = await call("create_note", {
      folder: "Research",
      name: "Travel Expenses.md",
      title: "Travel expenses",
      text: "x",
    });
    expect(upper.error).toBe(false);
    expect(upper.json()).toMatchObject({ name: "Travel Expenses.md" });
    const unknown = await call("reply_comment", {
      note: ids.pricing,
      comment_id: "cmt_nope",
      text: "Hello",
    });
    expect(unknown.text).toMatch(/No comment cmt_nope/);

    let online = true;
    const flaky = await connect(world, {
      fetch: (url, init) =>
        online ? world.server.fetch(url, init) : Promise.reject(new TypeError("offline")),
    });
    const read = (await flaky.call("read_note", { note: ids.pricing })).json() as { text: string };
    online = false;
    const proposal = await flaky.call("propose_edit", {
      note: ids.pricing,
      text: read.text.replace("14", "15"),
      base_version: 1,
    });
    expect(proposal.error).toBe(true);
    expect(proposal.text).toMatch(/can't be reached, so nothing was proposed/);
  });

  it("names a note without a name after its title, in the folder's own style", async () => {
    const { world } = await seeded();
    const web = world.web();
    // a folder made in the web app: notes named after their titles
    const request = prepareFolder(world.signer, world.key, {
      workspaceId: world.workspaceId,
      parentId: null,
      name: "Meetings",
      rootFolderId: null,
    });
    await web.api.call(routes.createFolder, {
      params: { workspaceId: world.workspaceId },
      body: request,
    });
    await web.engine.writeNote({
      noteId: newId("note"),
      folderId: request.id,
      baseVersion: 0,
      name: "Note One.md",
      text: "---\ntype: Note\ntitle: Note One\n---\nThe first meeting.\n",
    });
    const { call } = await connect(world, { direct: true });
    const create = async (folder: string, title: string) =>
      call("create_note", { folder, title, text: "Agreed on: the plan." });
    // like the web app: the title, spaces and capitals kept, unsafe characters replaced
    expect((await create("Meetings", "Q3: plans / goals")).json()).toMatchObject({
      mode: "written",
      name: "Q3- plans - goals.md",
    });
    // a folder whose notes are all lowercase words joined by dashes keeps that style
    expect((await create("Archive", "Old Plans")).json()).toMatchObject({
      mode: "written",
      name: "old-plans.md",
    });
    // a clash is refused, suggesting a numbered name in the same style
    const again = await create("Meetings", "Note One");
    expect(again.error).toBe(true);
    expect(again.text).toMatch(/Meetings\/Note One\.md exists already/);
    expect(again.text).toContain("`Note One 2.md`");
    const kebab = await create("Archive", "Old pricing");
    expect(kebab.text).toContain("`old-pricing-2.md`");
  });

  it("lists stale notes with ISO dates", async () => {
    const { world, web, research } = await seeded();
    await web.engine.writeNote({
      noteId: newId("note"),
      folderId: research,
      baseVersion: 0,
      name: "old-rates.md",
      text: note("Old rates", "Gone.", "stale_after: 2020-01-01\n"),
    });
    const { call } = await connect(world);
    const { notes } = (await call("list_stale")).json() as {
      notes: { title: string; staleAfter: string; staleAt: string }[];
    };
    expect(notes).toMatchObject([
      { title: "Old rates", staleAfter: "2020-01-01", staleAt: "2020-01-02T00:00:00.000Z" },
    ]);
  });

  it("searches folders in any letter case, pages the hits and filters by checkState", async () => {
    const seed = await seeded();
    const { world } = seed;
    await setPolicy(seed, "review");
    await personEdits(seed);
    const { call } = await connect(world);
    const lower = (await call("search_notes", { query: "yearly", folder: "research" })).json() as {
      total: number;
      notes: { title: string; checkState: string }[];
    };
    expect(lower.notes.map((note) => note.title)).toEqual(["Annual plans"]);
    expect(lower.notes[0]?.checkState).toBe("agent-check-pending");
    expect((await call("search_notes", { query: "pro", folder: "Nowhere" })).text).toMatch(
      /No folder Nowhere/,
    );
    const paged = (await call("search_notes", { query: "pro", limit: 1 })).json() as {
      total: number;
      truncated: boolean;
      next_offset: number | null;
    };
    expect(paged).toMatchObject({ total: 2, truncated: true, next_offset: 1 });
    const pending = (
      await call("search_notes", { query: "yearly", status: "agent-check-pending" })
    ).json() as { notes: { title: string }[] };
    expect(pending.notes.map((note) => note.title)).toEqual(["Annual plans"]);
  });
});

describe("confirming a person's entries", () => {
  it("counts a human: entry only at the time the version's signed write names", async () => {
    const seed = await seeded();
    const { world, web, ids, research } = seed;
    await setPolicy(seed, "review");
    const current = (await web.engine.readNote(ids.annual)).text ?? "";
    const owner = `human:${world.accountId}`;
    // a future-dated entry (and any other time than the signed write's) confirms nothing
    await web.engine.writeNote({
      noteId: ids.annual,
      folderId: research,
      baseVersion: 1,
      name: "annual-plans.md",
      text: current
        .replace(
          "generated: { by: claude-code/2.0, at: 2026-09-01T10:00:00Z }",
          `generated: { by: ${owner}, at: 2099-01-01T00:00:00Z }\nverified:\n  - { by: ${owner}, at: 2099-01-01T00:00:00Z }`,
        )
        .replace("two months", "three months"),
    });
    const { call } = await connect(world);
    const read = (await call("read_note", { note: ids.annual })).json() as { checkState: string };
    expect(read.checkState).toBe("waiting-for-human");
  });
});

describe("the check loop end to end", () => {
  it("goes from a person's edit to fully verified once the passing check is applied", async () => {
    const seed = await seeded();
    const { world, web, ids, research } = seed;
    await setPolicy(seed, "review");
    await personEdits(seed);
    const { call, session } = await connect(world);
    await call("read_note", { note: ids.pricing });
    const recorded = (
      await call("record_check", { note: ids.annual, result: "pass", scope: [ids.pricing] })
    ).json() as { checkId: string; state: string };
    expect(recorded.state).toBe("fully-verified");
    // the web app applies it: the agent's entry written into the note, signed check_applied
    const current = await web.engine.readNote(ids.annual);
    const text = addVerified(parseNote(current.text ?? ""), "claude-code/2.1.0", new Date()).text;
    await web.engine.writeNote({
      noteId: ids.annual,
      folderId: research,
      baseVersion: current.version,
      name: "annual-plans.md",
      text,
      checkId: recorded.checkId as never,
    });
    await session.sync();
    const read = (await call("read_note", { note: ids.annual })).json() as {
      version: number;
      checkState: string;
    };
    expect(read).toMatchObject({ version: 3, checkState: "fully-verified" });
  });
});

describe("changes written directly or proposed, by the folder's policy", () => {
  interface Written {
    mode: string;
    noteId: string;
    version: number;
    name: string;
    status: string;
  }
  interface Proposed {
    mode: string;
    pendingId: string;
    status: string;
    reason: string;
  }

  it("writes directly where agents may, signed as the agent, and proposes where the folder asks first", async () => {
    const seed = await seeded();
    const { world, ids, archive } = seed;
    const { call, session } = await connect(world, { direct: true });
    expect((await call("list_workspaces")).json()).toMatchObject([
      { agentChanges: { writes: "direct", default: "direct", reviewFolders: [] } },
    ]);
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    const written = (
      await call("propose_edit", {
        note: ids.pricing,
        text: read.text.replace("14 EUR", "16 EUR"),
        base_version: 1,
        summary: "New price",
      })
    ).json() as Written;
    expect(written).toMatchObject({ mode: "written", version: 2, name: "pricing.md" });
    expect(written.status).toMatch(/edited by you and can undo/);
    expect(world.server.pending.size).toBe(0);
    // the agent reads its own version at once, and the person sees it signed by the agent
    expect((await call("read_note", { note: ids.pricing })).json()).toMatchObject({ version: 2 });
    const web = world.web();
    await web.engine.pull();
    const seen = await web.engine.readNote(ids.pricing);
    expect(seen.text).toContain("16 EUR");
    expect(seen.agentWrite?.tokenId).toBe(world.tokenId);
    // `generated` says who last wrote it; no `verified` entry of the agent's, nobody reviews here
    const provenance = readProvenance(parseNote(seen.text ?? "").frontmatter?.data ?? {});
    expect(provenance.generated?.by).toBe("claude-code/2.1.0");
    expect(provenance.verified).toEqual([]);
    expect(seen.text).not.toContain("verified");
    // with the agent's own unsigned `wrote` record for that version
    expect(
      world.server.events.some(
        (event) =>
          event.authorTokenId === world.tokenId &&
          event.noteVersion === 2 &&
          event.signed === null &&
          event.ciphertext !== null,
      ),
    ).toBe(true);
    const created = (
      await call("create_note", { folder: "Research", title: "Discounts", text: "Half price." })
    ).json() as Written;
    expect(created).toMatchObject({ mode: "written", version: 1, name: "discounts.md" });
    await web.engine.pull();
    const madeText = (await web.engine.readNote(created.noteId as never)).text ?? "";
    expect(readProvenance(parseNote(madeText).frontmatter?.data ?? {})).toMatchObject({
      generated: { by: "claude-code/2.1.0" },
      verified: [],
    });

    // the owner asks for approval in the Archive folder: there it is a proposal
    await setPolicy(seed, "direct", [{ folderId: archive, mode: "review" }]);
    // the feed announces the new revision (live pings pull it), so the tools read it again
    await session.sync();
    expect((await call("list_workspaces")).json()).toMatchObject([
      { agentChanges: { writes: "direct", default: "direct", reviewFolders: ["Archive"] } },
    ]);
    const old = (await call("read_note", { note: ids.old })).json() as { text: string };
    const proposed = (
      await call("propose_edit", {
        note: ids.old,
        text: old.text.replace("12 EUR", "13 EUR"),
        base_version: 1,
      })
    ).json() as Proposed;
    expect(proposed.mode).toBe("proposed");
    expect(proposed.status).toMatch(/approve/);
    expect(proposed.reason).toMatch(/asks for the person's approval/);
    expect(world.server.pending.has(proposed.pendingId as never)).toBe(true);
    expect(world.server.notes.get(ids.old)?.versions.length).toBe(1);
    // a proposal still carries the agent's own check, as before
    const review = await web.engine.readPending(proposed.pendingId as never);
    expect(readProvenance(parseNote(review.proposed).frontmatter?.data ?? {})).toMatchObject({
      generated: { by: "claude-code/2.1.0" },
      verified: [{ by: "claude-code/2.1.0" }],
    });
  });

  it("skips the review guards in a direct folder, and keeps them in a review folder", async () => {
    const seed = await seeded();
    const { world, ids } = seed;
    await personEdits(seed);
    const { call } = await connect(world, { direct: true });
    // nothing waits for a check where agents write directly
    expect((await call("list_pending_checks")).json()).toMatchObject({ total: 0 });
    const annual = (await call("read_note", { note: ids.annual })).json() as {
      text: string;
      version: number;
    };
    const written = (
      await call("propose_edit", {
        note: ids.annual,
        text: annual.text.replace("three", "four"),
        base_version: annual.version,
      })
    ).json() as Written;
    expect(written.mode).toBe("written");

    // review everywhere: today's behavior, guards and all
    await setPolicy(seed, "review");
    await seed.web.engine.pull();
    const agents = await seed.web.engine.readNote(ids.annual);
    const at = new Date().toISOString();
    await seed.web.engine.writeNote({
      noteId: ids.annual,
      folderId: seed.research,
      baseVersion: agents.version,
      name: "annual-plans.md",
      text: `---\ntype: Note\ntitle: Annual plans\ngenerated: { by: human:${world.accountId}, at: ${at} }\nverified:\n  - { by: human:${world.accountId}, at: ${at} }\n---\nYearly billing saves three months.\n`,
      signedAt: at,
    });
    const later = await connect(world, { direct: true });
    const pending = (await later.call("list_pending_checks")).json() as { total: number };
    expect(pending.total).toBe(1);
    const current = (await later.call("read_note", { note: ids.annual })).json() as {
      text: string;
      version: number;
    };
    const waiting = await later.call("propose_edit", {
      note: ids.annual,
      text: current.text.replace("three", "five"),
      base_version: current.version,
    });
    expect(waiting.error).toBe(true);
    expect(waiting.text).toMatch(/waiting for a check/);
    const pricing = (await later.call("read_note", { note: ids.pricing })).json() as {
      text: string;
    };
    const first = (
      await later.call("propose_edit", {
        note: ids.pricing,
        text: pricing.text.replace("14", "15"),
        base_version: 1,
      })
    ).json() as Proposed;
    expect(first.mode).toBe("proposed");
    const second = await later.call("propose_edit", {
      note: ids.pricing,
      text: pricing.text.replace("14", "17"),
      base_version: 1,
    });
    expect(second.text).toMatch(/open proposal for this note already/);
  });

  it("proposes when the server asks for approval, or the policy doesn't verify", async () => {
    const { world, ids } = await seeded();
    const { call, session } = await connect(world, { direct: true });
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    // the client's checked policy says direct, the server refuses: a proposal instead
    world.server.tamper.refuse = (route) =>
      route === "writeNoteAsAgent" ? "approval_required" : undefined;
    const refused = (
      await call("propose_edit", {
        note: ids.pricing,
        text: read.text.replace("14", "15"),
        base_version: 1,
      })
    ).json() as Proposed;
    expect(refused.mode).toBe("proposed");
    expect(refused.reason).toMatch(/asks for the person's approval/);
    // a write that falls back to a proposal carries a proposal's marks: the agent's own check too
    const fallback = await world.web().engine.readPending(refused.pendingId as never);
    expect(readProvenance(parseNote(fallback.proposed).frontmatter?.data ?? {})).toMatchObject({
      generated: { by: "claude-code/2.1.0" },
      verified: [{ by: "claude-code/2.1.0" }],
    });
    delete world.server.tamper.refuse;

    // a policy that isn't the one the owner signed: review everywhere
    await setPolicy({ world, web: world.web() }, "review");
    await session.sync();
    world.server.tamper.agentPolicy = (policy) => ({ ...policy, default: "direct" });
    const unverified = (
      await call("create_note", { folder: "Research", title: "Plans", text: "x" })
    ).json() as Proposed;
    expect(unverified.mode).toBe("proposed");
    expect(unverified.reason).toMatch(/couldn't be verified/);
    expect(world.server.notes.size).toBe(3);
    const [listed] = (await call("list_workspaces")).json() as {
      agentChanges: { default: string; reviewFolders?: string[]; note: string };
    }[];
    // review everywhere: no folder differs from that default
    expect(listed?.agentChanges).toMatchObject({ writes: "direct", default: "review" });
    expect(listed?.agentChanges.reviewFolders).toBeUndefined();
    expect(listed?.agentChanges.note).toMatch(/couldn't be verified/);
    expect(session.writesDirectly).toBe(true);
  });

  it("keeps proposing on an old connection, and on a key the owner never vouched for, saying to reconnect", async () => {
    const { world, ids } = await seeded();
    const old = await connect(world);
    expect(old.session.writesDirectly).toBe(false);
    const [listed] = (await old.call("list_workspaces")).json() as {
      agentChanges: { writes: string; note: string };
    }[];
    expect(listed?.agentChanges.writes).toBe("propose");
    expect(listed?.agentChanges.note).toMatch(/knowtarium connect/);
    const read = (await old.call("read_note", { note: ids.pricing })).json() as { text: string };
    const proposed = (
      await old.call("propose_edit", {
        note: ids.pricing,
        text: read.text.replace("14", "15"),
        base_version: 1,
      })
    ).json() as Proposed;
    expect(proposed.mode).toBe("proposed");
    expect(proposed.reason).toMatch(/`npx knowtarium connect` again, then restart the agent/);
    expect(proposed.reason).toMatch(/didn't vouch/);
    // no direct write was even tried
    expect(world.server.requests.some((request) => request.url.includes("agent-version"))).toBe(
      false,
    );

    // a key of its own, but not the one the owner vouched for: the server never sees a write
    const unvouched = await connect(world, { direct: { signing: createAgentSigningKeyPair() } });
    const created = (
      await unvouched.call("create_note", { folder: "Research", title: "Plans", text: "x" })
    ).json() as Proposed;
    expect(created.mode).toBe("proposed");
    expect(created.reason).toMatch(/knowtarium connect/);
    expect(world.server.agentWrites).toBe(0);
  });

  it("refuses a stale base after a 409, then writes once the agent redoes its change", async () => {
    const { world, web, ids, research } = await seeded();
    const { call } = await connect(world, { direct: true });
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    // the person saves meanwhile
    await web.engine.writeNote({
      noteId: ids.pricing,
      folderId: research,
      baseVersion: 1,
      name: "pricing.md",
      text: read.text.replace("14 EUR", "15 EUR"),
    });
    const stale = await call("propose_edit", {
      note: ids.pricing,
      text: read.text.replace("14 EUR", "16 EUR"),
      base_version: 1,
    });
    expect(stale.error).toBe(true);
    expect(stale.text).toMatch(/at version 2 now/);
    expect(stale.text).not.toMatch(/propose/);
    // read again: the current version is there at once, and the redone change is written
    const again = (await call("read_note", { note: ids.pricing })).json() as {
      text: string;
      version: number;
    };
    expect(again.version).toBe(2);
    expect(again.text).toContain("15 EUR");
    const written = (
      await call("propose_edit", {
        note: ids.pricing,
        text: again.text.replace("Pro is", "The Pro plan is"),
        base_version: 2,
      })
    ).json() as Written;
    expect(written).toMatchObject({ mode: "written", version: 3 });
  });

  it("proposes once the daily cap on direct writes is reached, and says to wait on the per-minute limit", async () => {
    const { world, ids } = await seeded();
    world.server.agentWriteDailyCap = 1;
    let perMinute = false;
    const { call } = await connect(world, {
      direct: true,
      fetch: (url, init) =>
        perMinute && url.endsWith("/agent-version")
          ? Promise.resolve(
              jsonAnswer(
                429,
                { error: { code: "rate_limited", message: "Slow down", retryAfterSeconds: 30 } },
                { "Retry-After": "30" },
              ),
            )
          : world.server.fetch(url, init),
    });
    const first = (
      await call("create_note", { folder: "Research", title: "One", text: "x" })
    ).json() as Written;
    expect(first.mode).toBe("written");
    // past the cap (a Retry-After of an hour): a proposal instead
    const second = (
      await call("create_note", { folder: "Research", title: "Two", text: "x" })
    ).json() as Proposed;
    expect(second.mode).toBe("proposed");
    expect(second.reason).toMatch(/today's limit/);
    expect(world.server.pending.size).toBe(1);

    perMinute = true;
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    const limited = await call("propose_edit", {
      note: ids.pricing,
      text: read.text.replace("14", "15"),
      base_version: 1,
    });
    expect(limited.error).toBe(true);
    expect(limited.text).toMatch(/nothing was saved\. Wait 30 seconds/);
    expect(world.server.pending.size).toBe(1);
  });

  it("says a direct write may not have been saved when Knowtarium can't be reached", async () => {
    const { world, ids } = await seeded();
    let online = true;
    const { call } = await connect(world, {
      direct: true,
      fetch: (url, init) =>
        online ? world.server.fetch(url, init) : Promise.reject(new TypeError("offline")),
    });
    const read = (await call("read_note", { note: ids.pricing })).json() as { text: string };
    online = false;
    const answer = await call("propose_edit", {
      note: ids.pricing,
      text: read.text.replace("14", "15"),
      base_version: 1,
    });
    expect(answer.error).toBe(true);
    expect(answer.text).toMatch(/may not have been saved\. Read the note again/);
  });

  it("shows verification and pending checks only in review folders", async () => {
    const seed = await seeded();
    const { world, web, ids, archive } = seed;
    await setPolicy(seed, "direct", [{ folderId: archive, mode: "review" }]);
    // the person edits a note in each folder
    await personEdits(seed);
    const old = await web.engine.readNote(ids.old);
    const at = new Date().toISOString();
    await web.engine.writeNote({
      noteId: ids.old,
      folderId: archive,
      baseVersion: old.version,
      name: "old-pricing.md",
      text: `---\ntype: Note\ntitle: Old pricing\ngenerated: { by: human:${world.accountId}, at: ${at} }\nverified:\n  - { by: human:${world.accountId}, at: ${at} }\n---\nPro was 11 EUR a month.\n`,
      signedAt: at,
    });
    const { call } = await connect(world, { direct: true });
    const pending = (await call("list_pending_checks")).json() as { notes: { id: string }[] };
    expect(pending.notes.map((entry) => entry.id)).toEqual([ids.old]);
    // a direct folder: no verification state, only freshness
    expect((await call("read_note", { note: ids.annual })).json()).toMatchObject({
      agentChanges: "direct",
      state: null,
      checkState: null,
      conflicts: [],
      freshness: expect.any(String) as unknown,
    });
    expect((await call("read_note", { note: ids.old })).json()).toMatchObject({
      agentChanges: "review",
      checkState: "agent-check-pending",
    });
    const filtered = (
      await call("search_notes", { query: "pro yearly", status: "agent-check-pending" })
    ).json() as { notes: { id: string }[] };
    expect(filtered.notes.every((entry) => entry.id === ids.old)).toBe(true);
    await call("read_note", { note: ids.pricing });
    const refused = await call("record_check", {
      note: ids.annual,
      result: "pass",
      scope: [ids.pricing],
    });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/apply directly, so nothing there waits for a check/);
  });

  it("says nothing was proposed when a fallback proposal can't reach Knowtarium", async () => {
    const seed = await seeded();
    const { world, ids, archive } = seed;
    await setPolicy(seed, "direct", [{ folderId: archive, mode: "review" }]);
    const { call } = await connect(world, {
      direct: true,
      fetch: (url, init) =>
        url.endsWith("/pending-changes")
          ? Promise.reject(new TypeError("offline"))
          : world.server.fetch(url, init),
    });
    const old = (await call("read_note", { note: ids.old })).json() as { text: string };
    const answer = await call("propose_edit", {
      note: ids.old,
      text: old.text.replace("12", "13"),
      base_version: 1,
    });
    expect(answer.error).toBe(true);
    expect(answer.text).toMatch(/can't be reached, so nothing was proposed/);
  });

  it("tells the agent about its own open proposals on a note it just wrote", async () => {
    const seed = await seeded();
    const { world, ids } = seed;
    // a proposal from when the connection could only propose
    const before = await connect(world);
    const read = (await before.call("read_note", { note: ids.pricing })).json() as {
      text: string;
    };
    const proposed = (
      await before.call("propose_edit", {
        note: ids.pricing,
        text: read.text.replace("14", "15"),
        base_version: 1,
      })
    ).json() as Proposed;
    const { call } = await connect(world, { direct: true });
    const written = (
      await call("propose_edit", {
        note: ids.pricing,
        text: read.text.replace("14", "16"),
        base_version: 1,
      })
    ).json() as Written & { openProposals?: string[]; openProposalsNote?: string };
    expect(written.mode).toBe("written");
    expect(written.openProposals).toEqual([proposed.pendingId]);
    expect(written.openProposalsNote).toMatch(/tell the person/);
  });

  it("offers no tool that deletes a note", async () => {
    const { world } = await seeded();
    const { client } = await connect(world, { direct: true });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => /delete|remove/.test(name))).toEqual([]);
  });
});

/** A JSON answer as the sync API would send it. */
function jsonAnswer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const all = new Map(
    Object.entries({ "content-type": "application/json", ...headers }).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    status,
    headers: { get: (name: string) => all.get(name.toLowerCase()) ?? null },
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

describe("the workspace's history period, for agents", () => {
  it("shows the period in list_workspaces, read-only, and what it means", async () => {
    const { world } = await seeded();
    world.server.historyRetentionDays = 7;
    const { call } = await connect(world);
    const [listed] = (await call("list_workspaces")).json() as {
      history: { keptDays: number | null; note: string };
    }[];
    expect(listed?.history.keptDays).toBe(7);
    expect(listed?.history.note).toContain("kept for 7 days after a newer version replaces them");
    expect(listed?.history.note).toContain("Only the person can change this");
  });

  it("says nothing it doesn't know when the server doesn't answer the period", async () => {
    const { world } = await seeded();
    world.server.tamper.refuse = (route) =>
      route === "getHistoryRetention" ? "not_found" : undefined;
    const { call } = await connect(world);
    const [listed] = (await call("list_workspaces")).json() as {
      history: { keptDays: number | null; note: string };
    }[];
    expect(listed?.history.keptDays).toBeNull();
    expect(listed?.history.note).toContain("for the period the person set");
  });

  it("marks versions whose content was removed in note_history", async () => {
    const seed = await seeded();
    const { world, ids } = seed;
    await personEdits(seed);
    world.server.pruneVersion(ids.annual, 1);
    const { call } = await connect(world);
    const history = (await call("note_history", { note: ids.annual })).json() as {
      entries: { kind: string; version?: number; contentRemoved?: boolean; signature?: string }[];
    };
    const versions = history.entries.filter((entry) => entry.kind === "version");
    expect(versions).toMatchObject([
      { version: 1, contentRemoved: true, signature: "verified" },
      { version: 2, signature: "verified" },
    ]);
    expect(versions[1]).not.toHaveProperty("contentRemoved");
  });

  it("lists a pending check without a diff when the version before was removed", async () => {
    const seed = await seeded();
    const { world, ids } = seed;
    await setPolicy(seed, "review");
    await personEdits(seed);
    world.server.pruneVersion(ids.annual, 1);
    const { call } = await connect(world);
    const answer = await call("list_pending_checks");
    expect(answer.error).toBe(false);
    const { notes } = answer.json() as {
      notes: { id: string; diff: string | null; diffUnavailable?: string }[];
    };
    expect(notes).toMatchObject([{ id: ids.annual, diff: null }]);
    expect(notes[0]?.diffUnavailable).toMatch(/removed after the workspace's history period/);
  });
});
