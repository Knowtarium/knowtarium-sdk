import { describe, expect, it, vi } from "vitest";

import { b64, ct, id, now } from "../../protocol/test-fixtures.js";
import { routes } from "../../protocol/index.js";
import {
  InvalidResponseError,
  isSyncApiError,
  NetworkError,
  RequestValidationError,
  SyncApiError,
} from "../errors/index.js";
import { createAbortController } from "../platform/abort.js";
import type { FetchInit, FetchResponse } from "../platform/fetch.js";
import { header, ManualScheduler, type RecordedCall, response } from "../testing/http.js";
import { type ApiClientOptions, createApiClient } from "./client.js";

const workspaceId = id("ws");
const noteId = id("note");
const folderId = id("fld");
const token = `kta_${"a".repeat(40)}`;

const workspace = {
  id: workspaceId,
  encName: ct,
  ownerId: id("acc"),
  ownerSignPublicKey: b64(32),
  keyGeneration: 1,
  currentVersion: 3,
  createdAt: now,
  updatedAt: now,
};

function setup(
  answers: (FetchResponse | Error)[],
  options: Partial<ApiClientOptions> = {},
): {
  calls: RecordedCall[];
  client: ReturnType<typeof createApiClient>;
  scheduler: ManualScheduler;
} {
  const calls: RecordedCall[] = [];
  const scheduler = new ManualScheduler();
  const fetch = vi.fn((url: string, init: FetchInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) return Promise.reject(new Error("no answer left"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const client = createApiClient({
    baseUrl: "https://api.test/",
    fetch,
    auth: { kind: "session" },
    scheduler,
    random: () => 0.5,
    // no attempt timers, so `scheduler.delays` holds only the backoff waits
    timeoutMs: 0,
    ...options,
  });
  return { calls, client, scheduler };
}

/** Runs a call to completion while the scheduler moves time along. */
async function settle<T>(scheduler: ManualScheduler, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  tracked.catch(() => undefined);
  while (!state.done) await scheduler.advance(1000);
  return tracked;
}

describe("requests", () => {
  it("sends a session GET with the protocol header, the cookie and no caching", async () => {
    const { calls, client } = setup([response(200, { workspace })]);
    const result = await client.call(routes.getWorkspace, { params: { workspaceId } });
    expect(result.data.workspace.id).toBe(workspaceId);
    const [call] = calls;
    expect(call?.url).toBe(`https://api.test/workspaces/${workspaceId}`);
    expect(call?.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
      credentials: "include",
    });
    expect(header(call, "Knowtarium-Protocol-Version")).toBe("2");
    expect(header(call, "Knowtarium-Request")).toBeUndefined();
    expect(header(call, "Authorization")).toBeUndefined();
  });

  it("adds the CSRF header and a JSON body to state-changing session requests", async () => {
    const { calls, client } = setup([response(200, { workspace })]);
    await client.call(routes.renameWorkspace, { params: { workspaceId }, body: { encName: ct } });
    const [call] = calls;
    expect(call?.init.method).toBe("PATCH");
    expect(header(call, "Knowtarium-Request")).toBe("1");
    expect(header(call, "Content-Type")).toBe("application/json");
    expect(call?.init.body).toBe(JSON.stringify({ encName: ct }));
  });

  it("sends the agent token as a bearer token, without cookies", async () => {
    const { calls, client } = setup([response(200, { workspaces: [workspace] })], {
      auth: { kind: "agent", token: () => token },
    });
    await client.call(routes.listWorkspaces);
    expect(header(calls[0], "Authorization")).toBe(`Bearer ${token}`);
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  it("applies the fixed headers last", async () => {
    const { calls, client } = setup(
      [response(201, { ticket: `ktl_${"b".repeat(40)}`, expiresAt: now })],
      {
        auth: { kind: "agent", token },
        headers: {
          "knowtarium-protocol-version": "99",
          authorization: "Bearer stolen",
          "knowtarium-request": "0",
          "User-Agent": "knowtarium-cli/1",
        },
      },
    );
    await client.call(routes.createLiveTicket, { params: { workspaceId } });
    const headers = calls[0]?.init.headers ?? {};
    expect(headers).toEqual({
      "User-Agent": "knowtarium-cli/1",
      "Knowtarium-Protocol-Version": "2",
      "Knowtarium-Request": "1",
      Authorization: `Bearer ${token}`,
    });
  });

  it("sends raw ciphertext with the route's headers and reads the ETag", async () => {
    const blob = new Uint8Array(64).fill(7);
    const { calls, client } = setup([response(200, blob, { ETag: '"4"' })]);
    const result = await client.call(routes.getVersion, {
      params: { workspaceId, noteId, version: 4 },
    });
    expect(result.data).toEqual(blob);
    expect(result.version).toBe(4);
    expect(calls[0]?.url).toBe(
      `https://api.test/workspaces/${workspaceId}/notes/${noteId}/versions/4`,
    );
  });

  it("serializes the query", async () => {
    const { calls, client } = setup([
      response(200, { workspaceVersion: 0, changes: [], hasMore: false }),
    ]);
    await client.call(routes.listChanges, {
      params: { workspaceId },
      query: { since: 12, limit: 50 },
    });
    expect(calls[0]?.url).toBe(
      `https://api.test/workspaces/${workspaceId}/changes?since=12&limit=50`,
    );
  });

  it("validates path params against the protocol ID schemas before sending", async () => {
    const { calls, client } = setup([]);
    const call = client.call(routes.getWorkspace, {
      params: { workspaceId: "ws_../../account" },
    });
    await expect(call).rejects.toBeInstanceOf(RequestValidationError);
    await expect(call).rejects.toMatchObject({ part: "params", at: ["workspaceId"] });
    expect(calls).toHaveLength(0);
  });

  it("validates route headers and bodies before sending", async () => {
    const { calls, client } = setup([]);
    await expect(
      client.call(routes.writeNote, {
        params: { workspaceId, noteId },
        headers: {
          "if-match": "3",
          "knowtarium-folder-id": folderId,
          "knowtarium-signature": b64(64),
          "knowtarium-signed-at": now,
        },
        body: new Uint8Array(64),
      }),
    ).rejects.toMatchObject({ part: "headers", at: ["if-match"] });
    await expect(
      client.call(routes.renameWorkspace, { params: { workspaceId }, body: { encName: "x" } }),
    ).rejects.toMatchObject({ part: "body" });
    expect(calls).toHaveLength(0);
  });

  it("refuses routes the auth mode can't call", async () => {
    const agent = setup([], { auth: { kind: "agent", token } });
    await expect(
      agent.client.call(routes.renameWorkspace, { params: { workspaceId }, body: { encName: ct } }),
    ).rejects.toMatchObject({ part: "auth" });
    const session = setup([]);
    await expect(session.client.call(routes.getCurrentToken)).rejects.toMatchObject({
      part: "auth",
    });
  });
});

describe("responses", () => {
  it("maps protocol errors to typed errors", async () => {
    const { client } = setup([
      response(409, { error: { code: "conflict", message: "stale", currentVersion: 7 } }),
    ]);
    const error = await client
      .call(routes.getWorkspace, { params: { workspaceId } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SyncApiError);
    expect(isSyncApiError(error, "conflict")).toBe(true);
    expect((error as SyncApiError).currentVersion).toBe(7);
    expect((error as SyncApiError).status).toBe(409);
  });

  it("maps error pages without a protocol body by status", async () => {
    const { client } = setup([response(404, new Uint8Array([60, 104, 49, 62]))]);
    await expect(
      client.call(routes.getWorkspace, { params: { workspaceId } }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a body that doesn't match the route's schema", async () => {
    const { client } = setup([response(200, { workspace: { ...workspace, id: "nope" } })]);
    await expect(
      client.call(routes.getWorkspace, { params: { workspaceId } }),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("refuses a raw version without a valid ETag", async () => {
    for (const tag of ["W/4", 'w/"4"', 'W/"04"', 'W/W/"4"']) {
      const { client } = setup([response(200, new Uint8Array(64), { ETag: tag })]);
      const error = await client
        .call(routes.getVersion, { params: { workspaceId, noteId, version: 4 } })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InvalidResponseError);
      expect(error).toMatchObject({ problem: "headers" });
    }
  });

  it('reads a weak ETag (W/"7", as a compressing edge sends it) as the same version', async () => {
    const { client } = setup([response(200, new Uint8Array(64), { ETag: 'W/"7"' })]);
    const result = await client.call(routes.getVersion, {
      params: { workspaceId, noteId, version: 7 },
    });
    expect(result.version).toBe(7);
  });
});

describe("retries", () => {
  it("retries idempotent requests after network errors, with backoff", async () => {
    const { calls, client, scheduler } = setup([
      new TypeError("fetch failed"),
      response(502),
      response(200, { workspace }),
    ]);
    const result = await settle(
      scheduler,
      client.call(routes.getWorkspace, { params: { workspaceId } }),
    );
    expect(result.data.workspace.id).toBe(workspaceId);
    expect(calls).toHaveLength(3);
    expect(scheduler.delays).toEqual([225, 450]);
  });

  it("gives up after the last attempt", async () => {
    const { calls, client, scheduler } = setup([new TypeError("down"), new TypeError("down")], {
      retry: { maxAttempts: 2 },
    });
    await expect(
      settle(scheduler, client.call(routes.getWorkspace, { params: { workspaceId } })),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(2);
  });

  it("never repeats a write after a network error unless told it is idempotent", async () => {
    const { calls, client } = setup([new TypeError("reset")]);
    await expect(
      client.call(routes.renameWorkspace, { params: { workspaceId }, body: { encName: ct } }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(1);
  });

  it("waits for Retry-After on 429, for writes too", async () => {
    const { calls, client, scheduler } = setup([
      response(
        429,
        { error: { code: "rate_limited", message: "slow", retryAfterSeconds: 2 } },
        {
          "Retry-After": "2",
        },
      ),
      response(200, { workspace }),
    ]);
    await settle(
      scheduler,
      client.call(routes.renameWorkspace, { params: { workspaceId }, body: { encName: ct } }),
    );
    expect(calls).toHaveLength(2);
    expect(scheduler.delays).toEqual([2000]);
  });

  it("fails at once when Retry-After is longer than it waits", async () => {
    const { calls, client } = setup([
      response(
        503,
        { error: { code: "unavailable", message: "later" } },
        { "Retry-After": "3600" },
      ),
    ]);
    await expect(
      client.call(routes.getWorkspace, { params: { workspaceId } }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("doesn't retry a write on 503 without Retry-After", async () => {
    const { calls, client } = setup([response(503)]);
    await expect(
      client.call(routes.renameWorkspace, { params: { workspaceId }, body: { encName: ct } }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toHaveLength(1);
  });
});

describe("cancellation", () => {
  function hanging(scheduler: ManualScheduler, timeoutMs?: number) {
    const inits: FetchInit[] = [];
    const client = createApiClient({
      baseUrl: "https://api.test",
      auth: { kind: "session" },
      scheduler,
      random: () => 0.5,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      fetch: (_url, init) => {
        inits.push(init);
        return new Promise<FetchResponse>(() => undefined);
      },
    });
    return { client, inits };
  }

  it("times out an attempt that never answers, and aborts its fetch", async () => {
    const scheduler = new ManualScheduler();
    const { client, inits } = hanging(scheduler, 5000);
    const call = client.call(routes.renameWorkspace, {
      params: { workspaceId },
      body: { encName: ct },
    });
    const outcome = call.catch((error: unknown) => error);
    await scheduler.advance(5000);
    expect(await outcome).toMatchObject({ name: "NetworkError", reason: "timeout" });
    expect(inits).toHaveLength(1);
    expect((inits[0]?.signal as { aborted: boolean }).aborted).toBe(true);
  });

  it("retries a timed out GET, then gives up", async () => {
    const scheduler = new ManualScheduler();
    const { client, inits } = hanging(scheduler, 1000);
    const outcome = client
      .call(routes.getWorkspace, { params: { workspaceId }, timeoutMs: 2000 })
      .catch((error: unknown) => error);
    await scheduler.advance(60_000);
    expect(await outcome).toMatchObject({ reason: "timeout" });
    expect(inits).toHaveLength(4);
  });

  it("stops at once when the caller aborts, without retrying", async () => {
    const scheduler = new ManualScheduler();
    const { client, inits } = hanging(scheduler);
    const controller = createAbortController();
    if (controller === undefined) throw new Error("this runtime has no AbortController");
    const outcome = client
      .call(routes.getWorkspace, { params: { workspaceId }, signal: controller.signal })
      .catch((error: unknown) => error);
    await scheduler.advance(0);
    controller.abort();
    expect(await outcome).toMatchObject({ reason: "aborted" });
    expect(inits).toHaveLength(1);
    await expect(
      client.call(routes.getWorkspace, { params: { workspaceId }, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(inits).toHaveLength(1);
  });
});

describe("revocation and billing answers", () => {
  it("parses a revocation that asks for a key rotation, and a refused workspace", async () => {
    const tokenId = id("tok");
    const plan = { id: "free", storageQuotaBytes: 524_288_000, maxWorkspaces: 1 };
    const usage = { usedBytes: 0, quotaBytes: 524_288_000, workspaceCount: 1, maxWorkspaces: 1 };
    const { client } = setup([
      response(200, { ok: true, mustRotateKey: { workspaceId } }),
      response(402, { error: { code: "workspace_limit", message: "limit", plan, usage } }),
    ]);
    const revoked = await client.call(routes.revokeToken, { params: { tokenId } });
    expect(revoked.data.mustRotateKey).toEqual({ workspaceId });
    const error = await client
      .call(routes.renameWorkspace, { params: { workspaceId }, body: { encName: ct } })
      .catch((caught: unknown) => caught);
    expect(isSyncApiError(error, "workspace_limit")).toBe(true);
    expect((error as SyncApiError).detail).toMatchObject({ plan, usage });
  });
});
