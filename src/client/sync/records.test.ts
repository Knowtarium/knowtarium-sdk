import { beforeAll, describe, expect, it } from "vitest";

import { ready } from "../../crypto/index.js";
import type { CheckRecord, NoteComment, NoteId } from "../../protocol/index.js";
import { b64 } from "../../protocol/test-fixtures.js";
import { InvalidResponseError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { World } from "../testing/world.js";
import { pageBySeq } from "./paging.js";
import { fetchChecks, fetchComments, fetchPending, fetchVersions } from "./records.js";

beforeAll(ready);

const ciphertext = b64(80);
const at = "2026-09-30T12:00:00.000Z";

function seed(world: World, count: number, noteIds: readonly [NoteId, ...NoteId[]]): void {
  for (let i = 0; i < count; i++) {
    const seq = ++world.server.seq;
    const noteId = noteIds[i % noteIds.length] ?? noteIds[0];
    const comment: NoteComment = {
      id: newId("cmt"),
      workspaceId: world.workspaceId,
      noteId,
      authorId: world.tokenId,
      authorTokenId: world.tokenId,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      seq,
      ciphertext,
      signed: null,
    };
    const check: CheckRecord = {
      id: newId("chk"),
      workspaceId: world.workspaceId,
      noteId,
      noteVersion: 1,
      authorId: world.tokenId,
      authorTokenId: world.tokenId,
      createdAt: at,
      status: i % 3 === 0 ? "applied" : "unapplied",
      appliedVersion: i % 3 === 0 ? 2 : null,
      resolvedAt: i % 3 === 0 ? at : null,
      seq,
      ciphertext,
    };
    world.server.comments.push(comment);
    world.server.checks.push(check);
  }
}

function limitsSent(world: World, path: string): string[] {
  return world.server.requests
    .map((request) => request.url)
    .filter((url) => url.includes(path))
    .map((url) => /[?&]limit=(\d+)/.exec(url)?.[1] ?? "");
}

describe("comments and check records", () => {
  it("reads every comment page by page, in seq order", async () => {
    const world = new World();
    const noteIds: [NoteId, NoteId] = [newId("note"), newId("note")];
    seed(world, 2500, noteIds);
    const client = world.cli();
    const context = { api: client.api, workspaceId: world.workspaceId };

    const comments = await fetchComments(context);
    expect(comments).toHaveLength(2500);
    expect(comments.map((comment) => comment.seq)).toEqual(
      [...comments.map((comment) => comment.seq)].sort((a, b) => a - b),
    );
    expect(limitsSent(world, "/comments")).toEqual(["1000", "1000", "1000"]);

    const later = await fetchComments(context, { since: comments[1999]?.seq ?? 0 });
    expect(later).toHaveLength(500);
    const forNote = await fetchComments(context, { noteId: noteIds[0] });
    expect(forNote).toHaveLength(1250);
  });

  it("reads every check record page by page, filtered by status", async () => {
    const world = new World();
    seed(world, 2100, [newId("note")]);
    const client = world.web();
    const context = { api: client.api, workspaceId: world.workspaceId };

    expect(await fetchChecks(context)).toHaveLength(2100);
    const applied = await fetchChecks(context, { status: "applied" });
    expect(applied).toHaveLength(700);
    expect(applied.every((check) => check.status === "applied")).toBe(true);
  });

  it("refuses a page that claims more without moving forward", async () => {
    const stuck = () => Promise.resolve({ items: [{ seq: 4 }], hasMore: true });
    await expect(pageBySeq("GET /x", stuck, { since: 4 })).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
    const empty = () => Promise.resolve({ items: [], hasMore: true });
    await expect(pageBySeq("GET /x", empty)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("stops at `until` once it has every item up to it", async () => {
    const asked: (number | undefined)[] = [];
    const pages = (since: number | undefined) => {
      asked.push(since);
      const from = since ?? 0;
      return Promise.resolve({ items: [{ seq: from + 1 }, { seq: from + 2 }], hasMore: true });
    };
    const items = await pageBySeq("GET /x", pages, { until: 3 });
    expect(items.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(asked).toEqual([undefined, 2]);
  });
});

describe("paged pending changes and versions", () => {
  it("follows hasMore with the last seq (pending) or version (versions)", async () => {
    const asked: Record<string, unknown>[] = [];
    const pages: Record<
      string,
      { items: { id?: string; seq?: number; version?: number }[]; more: boolean }[]
    > = {
      // pc_a is decided while paging: it comes again on the next page, with its new seq
      "GET /workspaces/:workspaceId/pending-changes": [
        {
          items: [
            { id: "pc_a", seq: 3 },
            { id: "pc_b", seq: 5 },
          ],
          more: true,
        },
        { items: [{ id: "pc_a", seq: 8 }], more: false },
      ],
      "GET /workspaces/:workspaceId/notes/:noteId/versions": [
        { items: [{ version: 1 }, { version: 2 }], more: true },
        { items: [{ version: 3 }], more: false },
      ],
    };
    const api = {
      call: (
        route: { method: string; path: string },
        input: { query: Record<string, unknown> },
      ) => {
        asked.push(input.query);
        const page = pages[`${route.method} ${route.path}`]?.shift();
        if (page === undefined) throw new Error("no more pages");
        return Promise.resolve({
          data: route.path.endsWith("versions")
            ? { versions: page.items, hasMore: page.more }
            : { pending: page.items, hasMore: page.more, workspaceVersion: 9 },
        });
      },
    };
    const context = { api: api as never, workspaceId: newId("ws") };
    const pending = await fetchPending(context, { status: "open" });
    expect(pending.map((change) => [change.id, change.seq])).toEqual([
      ["pc_b", 5],
      ["pc_a", 8],
    ]);
    const versions = await fetchVersions(context, newId("note"));
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(asked).toMatchObject([
      { status: "open", limit: 1000 },
      { status: "open", since: 5, limit: 1000 },
      { limit: 1000 },
      { since: 2, limit: 1000 },
    ]);
  });
});
