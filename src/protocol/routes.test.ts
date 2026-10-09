import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineRoute,
  pathFor,
  needsCsrfHeader,
  RAW_BYTES,
  REQUEST_HEADERS,
  RESPONSE_HEADERS,
  ROUTE_LIST,
  routeKey,
  routes,
  WEBSOCKET,
  type RequestBody,
  type ResponseBody,
  type RouteParams,
  type ChangePasswordRequest,
  type WorkspaceResponse,
} from "./index.js";
import { b64, id, now } from "./test-fixtures.js";

/** Every route the contract promises, by area. Adding or removing a route means updating this. */
const EXPECTED: Record<string, readonly string[]> = {
  health: ["health"],
  auth: [
    "prelogin",
    "recoveryStart",
    "recoveryComplete",
    "requestAccountReset",
    "completeAccountReset",
  ],
  account: ["getAccount", "changePassword", "replaceRecoveryKey", "revokeSession"],
  plans: [
    "listPlans",
    "getAccountPlan",
    "startCheckout",
    "changePlan",
    "cancelPlanChange",
    "createPortalSession",
  ],
  keys: ["listKeys", "rotateWorkspaceKey"],
  workspaces: [
    "listWorkspaces",
    "createWorkspace",
    "getWorkspace",
    "renameWorkspace",
    "deleteWorkspace",
  ],
  folders: ["listFolders", "createFolder", "updateFolder", "deleteFolder"],
  changes: ["listChanges"],
  notes: [
    "getNote",
    "writeNote",
    "writeNoteAsAgent",
    "deleteNote",
    "listVersions",
    "getVersion",
    "getVersions",
  ],
  history: ["getHistorySettings", "setHistorySettings", "getHistoryRetention"],
  attachments: [
    "createAttachment",
    "uploadAttachmentChunk",
    "completeAttachment",
    "getAttachment",
    "getAttachmentChunk",
    "deleteAttachment",
  ],
  pending: [
    "submitPending",
    "listPending",
    "getPending",
    "getPendingBlob",
    "approvePending",
    "rejectPending",
  ],
  agentPolicy: ["getAgentPolicy", "setAgentPolicy"],
  events: ["listEvents", "addEvent"],
  comments: ["listComments", "addComment", "updateComment"],
  checks: ["listChecks", "recordCheck", "resolveCheck"],
  tokens: ["listTokens", "getCurrentToken", "revokeToken"],
  connect: [
    "startConnect",
    "getConnect",
    "approveConnect",
    "relayConnect",
    "denyConnect",
    "pollConnect",
  ],
  live: ["createLiveTicket", "live"],
};

describe("route table", () => {
  it("has exactly the expected routes", () => {
    expect(Object.keys(routes).sort()).toEqual(Object.values(EXPECTED).flat().sort());
  });

  it("has one route per method and path", () => {
    const keys = ROUTE_LIST.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names every entry after its key", () => {
    for (const route of ROUTE_LIST) expect(routes[route.name]).toMatchObject({ path: route.path });
  });

  it.each(ROUTE_LIST.map((route) => [route.name, route] as const))(
    "%s is well formed",
    (_name, route) => {
      expect(route.path).toMatch(/^(\/[a-z-]+|\/:[A-Za-z]+)+$/);
      expect(route.summary.length).toBeGreaterThan(0);
      const names = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => name);
      expect(Object.keys(route.params.shape).sort()).toEqual(names.sort());
      if (route.method === "GET" || route.method === "DELETE") expect(route.body).toBeNull();
      if (route.body === RAW_BYTES) expect(["PUT", "POST"]).toContain(route.method);
      if (route.response === WEBSOCKET) {
        expect(route.method).toBe("GET");
        expect(route.status).toBe(101);
      }
      if (route.status === 201) expect(route.method).toBe("POST");
      if (route.method === "PATCH") expect(route.body).not.toBeNull();
      if (route.query) expect(route.query.safeParse({ unexpected: "1" }).success).toBe(false);
      expect(route.path).not.toMatch(/\/(approve|reject|resolve|complete|rotate|deny|ticket)\b/);
    },
  );

  it("keeps writes by agents to proposals, checks and their own signed versions", () => {
    const agentOnly = ROUTE_LIST.filter((route) => route.auth === "agent").map((r) => r.name);
    expect(agentOnly.sort()).toEqual([
      "getCurrentToken",
      "recordCheck",
      "submitPending",
      "writeNoteAsAgent",
    ]);
    for (const name of [
      "writeNote",
      "deleteNote",
      "approvePending",
      "rejectPending",
      "resolveCheck",
      "setAgentPolicy",
      "setHistorySettings",
      "getHistorySettings",
      "changePlan",
      "cancelPlanChange",
    ] as const) {
      expect(routes[name].auth).toBe("session");
    }
  });

  it("lets an agent sign on writeNoteAsAgent only", () => {
    const signing = ROUTE_LIST.filter((route) => route.agentSigns).map((route) => route.name);
    expect(signing).toEqual(["writeNoteAsAgent"]);
    expect(() =>
      defineRoute({
        method: "PUT",
        path: "/x",
        auth: "any",
        agentSigns: true,
        summary: "x",
        response: z.null(),
      }),
    ).toThrow(/agent route/);
  });

  it("never lets an agent delete a note", () => {
    const deletesNotes = ROUTE_LIST.filter(
      (route) => route.method === "DELETE" && route.path.includes("/notes/"),
    );
    expect(deletesNotes.map((route) => route.name)).toEqual(["deleteNote"]);
    expect(routes.deleteNote.auth).toBe("session");
  });

  it("uploads note versions and pending changes with their base version and folder", () => {
    expect(routes.submitPending.body).toBe(RAW_BYTES);
    expect(Object.keys(routes.submitPending.headers.shape).sort()).toEqual([
      "if-match",
      "knowtarium-folder-id",
      "knowtarium-pending-nonce",
    ]);
  });

  it("signs a person's raw writes in the same request", () => {
    const signing = ["knowtarium-signature", "knowtarium-signed-at"];
    expect(routes.writeNote.body).toBe(RAW_BYTES);
    // the check id only when the write applies an agent's check (`check_applied`)
    expect(Object.keys(routes.writeNote.headers.shape).sort()).toEqual([
      "if-match",
      "knowtarium-check-id",
      "knowtarium-folder-id",
      ...signing,
    ]);
    expect(Object.keys(routes.deleteNote.headers.shape).sort()).toEqual(["if-match", ...signing]);
    expect(routes.approvePending.body).toBe(RAW_BYTES);
    expect(Object.keys(routes.approvePending.headers.shape).sort()).toEqual(signing);
  });

  it("signs an agent's direct write with the policy revision it checked, never a check id", () => {
    expect(routes.writeNoteAsAgent.body).toBe(RAW_BYTES);
    expect(routes.writeNoteAsAgent.path).toBe(
      "/workspaces/:workspaceId/notes/:noteId/agent-version",
    );
    expect(Object.keys(routes.writeNoteAsAgent.headers.shape).sort()).toEqual([
      "if-match",
      "knowtarium-agent-policy-revision",
      "knowtarium-folder-id",
      "knowtarium-signature",
      "knowtarium-signed-at",
    ]);
    const headers = routes.writeNoteAsAgent.headers.parse({
      "if-match": '"4"',
      "knowtarium-folder-id": id("fld"),
      "knowtarium-signature": b64(64),
      "knowtarium-signed-at": now,
      "knowtarium-agent-policy-revision": "3",
    });
    expect(headers["knowtarium-agent-policy-revision"]).toBe(3);
    for (const bad of ["", "-1", "01", "1.5", "x"]) {
      expect(
        routes.writeNoteAsAgent.headers.safeParse({
          ...headers,
          "if-match": '"4"',
          "knowtarium-agent-policy-revision": bad,
        }).success,
        bad,
      ).toBe(false);
    }
  });

  it("requires the CSRF header on every state-changing route", () => {
    expect(REQUEST_HEADERS).toContain("Knowtarium-Request");
    for (const route of ROUTE_LIST)
      expect(needsCsrfHeader(route.method)).toBe(route.method !== "GET");
  });

  it("lists every header a route reads in the CORS lists", () => {
    const allowed = REQUEST_HEADERS.map((name) => name.toLowerCase());
    const exposed = RESPONSE_HEADERS.map((name) => name.toLowerCase());
    for (const route of ROUTE_LIST) {
      for (const key of Object.keys(route.headers?.shape ?? {})) expect(allowed).toContain(key);
      for (const key of Object.keys(route.responseHeaders?.shape ?? {})) {
        expect(exposed).toContain(key);
      }
    }
  });
});

describe("pathFor", () => {
  it("fills and encodes path parameters", () => {
    const workspaceId = id("ws");
    const noteId = id("note");
    expect(pathFor(routes.getVersion, { workspaceId, noteId, version: 3 })).toBe(
      `/workspaces/${workspaceId}/notes/${noteId}/versions/3`,
    );
    expect(pathFor(routes.health, {})).toBe("/health");
  });

  it("refuses a missing parameter", () => {
    expect(() => pathFor(routes.getWorkspace, {} as { workspaceId: string })).toThrow(
      /workspaceId/,
    );
  });

  it("parses path parameters with their schemas", () => {
    const params = routes.getVersion.params.parse({
      workspaceId: id("ws"),
      noteId: id("note"),
      version: "3",
    });
    expect(params.version).toBe(3);
    expect(routes.getWorkspace.params.safeParse({ workspaceId: "../etc" }).success).toBe(false);
  });

  it("refuses unknown path parameters when a route is defined", () => {
    expect(() =>
      defineRoute({
        method: "GET",
        path: "/x/:mystery",
        auth: "none",
        summary: "x",
        response: z.null(),
      }),
    ).toThrow(/mystery/);
  });
});

describe("route types", () => {
  it("infers bodies and params from the table", () => {
    expectTypeOf<
      RequestBody<typeof routes.changePassword>
    >().toEqualTypeOf<ChangePasswordRequest>();
    expectTypeOf<ResponseBody<typeof routes.getWorkspace>>().toEqualTypeOf<WorkspaceResponse>();
    expectTypeOf<RequestBody<typeof routes.writeNote>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<RequestBody<typeof routes.health>>().toEqualTypeOf<undefined>();
    expectTypeOf<RouteParams<typeof routes.getVersion>["version"]>().toEqualTypeOf<number>();
  });
});
