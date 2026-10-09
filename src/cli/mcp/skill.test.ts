// The conventions skill (skills/knowtarium-conventions) checked against the code: its frontmatter,
// the tools and OKF fields it names, its example note, and its consistency check run step by step
// through the MCP tools on the plain OKF fixture with a planted contradiction.
import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { importFixture } from "../../../test/import-fixtures.js";
import {
  importBundle,
  OKF_FIELDS,
  parseNote,
  planImport,
  validateFrontmatter,
} from "../../core/index.js";
import { ready, toBase64Url } from "../../crypto/index.js";
import { type FolderId, type NoteId, routes } from "../../protocol/index.js";
import {
  EncryptedCache,
  MemoryCacheAdapter,
  MemoryTrustStorage,
  newId,
  prepareFolder,
  TrustState,
} from "../../client/index.js";
import { World } from "../../client/testing/world.js";
import type { Connection } from "../storage/credentials.js";
import { createKnowtariumServer } from "./server.js";
import { WorkspaceSession } from "./session.js";

beforeAll(ready);

const SKILL = "skills/knowtarium-conventions/SKILL.md";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

/** The fixture imported into a fresh workspace the way the web app stores it. */
async function fixtureWorkspace() {
  const world = new World();
  const web = world.web();
  const imported = importBundle(importFixture("okf-plain"), {
    person: `human:${world.accountId}`,
    at: "2026-09-30T12:00:00Z",
  });
  const plan = planImport(imported);
  const folders = new Map<string, FolderId>();
  for (const folder of plan.folders) {
    const request = prepareFolder(world.signer, world.key, {
      workspaceId: world.workspaceId,
      parentId: folder.parent === null ? null : (folders.get(folder.parent) ?? null),
      name: folder.name,
      rootFolderId: folders.get("") ?? null,
    });
    await web.api.call(routes.createFolder, {
      params: { workspaceId: world.workspaceId },
      body: request,
    });
    folders.set(folder.path, request.id);
  }
  const ids = new Map<string, NoteId>();
  for (const note of plan.notes) {
    const noteId: NoteId = newId("note");
    ids.set(note.path, noteId);
    await web.engine.writeNote({
      noteId,
      folderId: folders.get(note.folder) ?? world.folderId,
      baseVersion: 0,
      name: note.name,
      text: note.text,
    });
  }
  return { world, web, folders, ids, total: plan.notes.length };
}

async function mcpClient(world: World, folderIds: FolderId[] = []) {
  world.server.agentFolderIds = folderIds;
  const connection: Connection = {
    apiUrl: "https://api.test",
    workspaceId: world.workspaceId,
    tokenId: world.tokenId,
    tokenSecret: world.agentToken,
    access: "read-write",
    folderIds,
    agentPrivateKey: toBase64Url(world.agent.privateKey),
    ownerId: world.accountId,
    ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
    connectedAt: new Date().toISOString(),
    // connected since direct writes: its own key, which the owner vouched for
    agentSignPrivateKey: toBase64Url(world.agentSigning.privateKey),
    ...(world.server.agentKeyRecords[0] === undefined
      ? {}
      : { agentKey: world.server.agentKeyRecords[0].signed }),
  };
  const adapter = new MemoryCacheAdapter();
  const session = await WorkspaceSession.open(connection, {
    fetch: world.server.fetch,
    trust: new TrustState(new MemoryTrustStorage()),
    cache: new EncryptedCache(adapter),
    adapter,
    log: () => undefined,
    apiRetry: { maxAttempts: 1 },
  });
  await session.start();
  const server = createKnowtariumServer([session], { version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);
  cleanups.push(async () => {
    session.stop();
    await client.close();
  });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ name, args });
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as { text: string }[];
    if (result.isError === true) throw new Error(`${name}: ${content?.text ?? ""}`);
    return JSON.parse(content?.text ?? "null") as T;
  };
  return { client, call, calls };
}

describe("the conventions skill", () => {
  it("has the frontmatter Claude skills need", async () => {
    const skill = await readFile(SKILL, "utf8");
    const data = parseNote(skill).frontmatter?.data ?? {};
    expect(data["name"]).toBe("knowtarium-conventions");
    expect(typeof data["description"]).toBe("string");
    expect(String(data["description"]).length).toBeLessThan(1024);
    expect(skill).not.toContain("—");
  });

  it("names only tools the server has, and every OKF field it lists exists", async () => {
    const skill = await readFile(SKILL, "utf8");
    const { world } = await fixtureWorkspace();
    const { client } = await mcpClient(world);
    const tools = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const named = new Set(
      [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)]
        .map((match) => match[1] ?? "")
        .filter((name) => !["stale_after", "base_version", "next_offset"].includes(name)),
    );
    expect([...named].filter((name) => !tools.has(name))).toEqual([]);
    // the workflow tools all appear
    for (const tool of ["list_pending_checks", "related_notes", "record_check", "propose_edit"]) {
      expect(named.has(tool)).toBe(true);
    }
    const fieldTable = skill.slice(skill.indexOf("### OKF fields"), skill.indexOf("A new note"));
    const fieldRows = [...fieldTable.matchAll(/^\| `([a-z_]+)`\s+\|/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(fieldRows.length).toBeGreaterThan(5);
    for (const field of fieldRows) expect(OKF_FIELDS).toContain(field);
  });

  it("gives an example note that is valid OKF and that create_note accepts", async () => {
    const skill = await readFile(SKILL, "utf8");
    const example = /```markdown\n([\s\S]*?)```/.exec(skill)?.[1] ?? "";
    const note = parseNote(example);
    expect(note.problems).toEqual([]);
    expect(validateFrontmatter(note.frontmatter?.data ?? {}).problems).toEqual([]);
    const { world } = await fixtureWorkspace();
    const { call } = await mcpClient(world);
    const created = await call<{ name: string; mode: string }>("create_note", {
      folder: "policies",
      name: "travel-expenses.md",
      title: "Travel expenses",
      text: example,
    });
    expect(created).toMatchObject({ name: "travel-expenses.md", mode: "written" });
  });

  it("runs its consistency check on the fixture: finds the planted contradiction, reading little", async () => {
    const { world, web, folders, ids, total } = await fixtureWorkspace();
    // the check is part of review: the workspace asks for approval of agent changes
    expect(
      (await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 })).status,
    ).toBe("saved");
    // planted: a FAQ that repeats the leave allowance
    const faq: NoteId = newId("note");
    await web.engine.writeNote({
      noteId: faq,
      folderId: folders.get("policies") ?? world.folderId,
      baseVersion: 0,
      name: "leave-faq.md",
      text: "---\ntype: Guide\ntitle: Leave FAQ\ndescription: Common questions about holidays\n---\nHow many days? Everyone gets 25 days, see [[Leave]].\n",
    });
    // the person changes the allowance in the leave policy
    const leave = ids.get("policies/leave.md") ?? ("" as NoteId);
    const current = (await web.engine.readNote(leave)).text ?? "";
    const owner = `human:${world.accountId}`;
    // the person's own entry names the time their write is signed at (what confirms it)
    const at = new Date().toISOString();
    await web.engine.writeNote({
      noteId: leave,
      folderId: folders.get("policies") ?? world.folderId,
      baseVersion: 1,
      name: "leave.md",
      text: current
        .replace(
          /generated: .*\n/,
          `generated: { by: ${owner}, at: ${at} }\nverified:\n  - { by: ${owner}, at: ${at} }\n`,
        )
        .replace("25 days", "30 days"),
      signedAt: at,
    });

    // the skill's steps, through the MCP tools
    const { call, calls } = await mcpClient(world);
    const pending = await call<{ notes: { id: string; version: number; diff: string }[] }>(
      "list_pending_checks",
    );
    expect(pending.notes.map((note) => note.id)).toEqual([leave]);
    const [changed] = pending.notes;
    const removed = (changed?.diff ?? "").split("\n").filter((line) => line.startsWith("- "));
    // the fact the change replaced: "25 days"
    const fact = /\d+ days/.exec(removed.join("\n"))?.[0] ?? "";
    expect(fact).toBe("25 days");

    const related = await call<{ id: string; title: string; description: string | null }[]>(
      "related_notes",
      { note: leave },
    );
    // titles and descriptions first: open only the notes about leave or holidays
    const relevant = related.filter((note) =>
      /leave|holiday/i.test(`${note.title} ${note.description ?? ""}`),
    );
    const scope: string[] = [];
    const conflicts: { note: string; detail: string }[] = [];
    for (const note of relevant) {
      const read = await call<{ text: string }>("read_note", { note: note.id });
      scope.push(note.id);
      if (read.text.includes(fact)) {
        conflicts.push({
          note: note.id,
          detail: `Still says ${fact}; the policy now says 30 days.`,
        });
      }
    }
    expect(conflicts.map((conflict) => conflict.note)).toEqual([faq]);
    await call("record_check", {
      note: leave,
      version: changed?.version,
      result: "fail",
      scope,
      conflicts,
    });
    await call("flag_conflict", {
      note: leave,
      text: "The Leave FAQ still says 25 days.",
      conflicts_with: [faq],
    });

    // far fewer notes read than the workspace holds, and the person's note left alone
    const reads = calls.filter((entry) => entry.name === "read_note").length;
    expect(reads).toBeLessThan(total + 1);
    expect(reads).toBeLessThanOrEqual(2);
    expect(
      calls.some((entry) => entry.name === "propose_edit" && entry.args["note"] === leave),
    ).toBe(false);
    const [check] = world.server.checks;
    expect(check?.noteId).toBe(leave);
    expect(check?.noteVersion).toBe(changed?.version);
    const state = await call<{ state: string }>("read_note", { note: leave });
    expect(state.state).toBe("conflict");
  });

  it("scopes like the server: no folders is everything, the root folder only its own notes", async () => {
    const { world, folders, total } = await fixtureWorkspace();
    const whole = await mcpClient(world);
    expect((await whole.call<{ total: number }>("list_notes")).total).toBe(total);
    const root = folders.get("") ?? world.folderId;
    const { call } = await mcpClient(world, [root]);
    const listed = await call<{ notes: { path: string }[] }>("list_notes");
    expect(listed.notes.map((note) => note.path).sort()).toEqual([
      "index.md",
      "log.md",
      "onboarding.md",
    ]);
  });
});
