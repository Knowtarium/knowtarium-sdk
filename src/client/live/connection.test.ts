import { describe, expect, it } from "vitest";

import { id, now } from "../../protocol/test-fixtures.js";
import type { ServerMessage } from "../../protocol/index.js";
import { createApiClient } from "../api/index.js";
import type { FetchResponse } from "../platform/fetch.js";
import { fakeSockets } from "../testing/fake-socket.js";
import { ManualScheduler, response } from "../testing/http.js";
import { LiveConnection, type LiveState, webSocketBase } from "./connection.js";
import { standardSocketFactory, type StandardWebSocket } from "./socket.js";

const workspaceId = id("ws");

function setup(tickets: (() => FetchResponse | Error)[] = []) {
  const scheduler = new ManualScheduler();
  const { connect, sockets } = fakeSockets();
  let issued = 0;
  const api = createApiClient({
    baseUrl: "http://localhost:8787",
    auth: { kind: "agent", token: `kta_${"a".repeat(40)}` },
    retry: { maxAttempts: 1 },
    scheduler,
    fetch: () => {
      const next = tickets.shift();
      const answer =
        next?.() ??
        response(201, { ticket: `ktl_${String(++issued).padStart(40, "0")}`, expiresAt: now });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });
  const messages: ServerMessage[] = [];
  const states: LiveState[] = [];
  const live = new LiveConnection({
    api,
    workspaceId,
    connect,
    scheduler,
    random: () => 1,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    pingIntervalMs: 30_000,
    pongTimeoutMs: 5000,
    stableAfterMs: 10_000,
    onMessage: (message) => messages.push(message),
    onState: (state) => states.push(state),
  });
  return { live, scheduler, sockets, messages, states };
}

const hello = { type: "hello", protocolVersion: 1, workspaceVersion: 3 };

describe("live connection", () => {
  it("opens the socket with a fresh ticket and passes messages on", async () => {
    const { live, scheduler, sockets, messages, states } = setup();
    live.start();
    await scheduler.advance(0);
    expect(sockets[0]?.url).toBe(
      `ws://localhost:8787/workspaces/${workspaceId}/live?protocol=2&ticket=ktl_${"0".repeat(39)}1`,
    );
    sockets[0]?.receive(hello);
    sockets[0]?.receive({ type: "changed", workspaceVersion: 4 });
    sockets[0]?.receive({ type: "nonsense" });
    expect(messages.map((message) => message.type)).toEqual(["hello", "changed"]);
    expect(states).toEqual(["connecting", "open"]);
    expect(live.state).toBe("open");
  });

  it("reconnects with growing backoff and a new ticket each time", async () => {
    const { live, scheduler, sockets, states } = setup();
    live.start();
    await scheduler.advance(0);
    sockets[0]?.drop();
    expect(live.state).toBe("reconnecting");
    await scheduler.advance(999);
    expect(sockets).toHaveLength(1);
    await scheduler.advance(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.url).toContain(`ticket=ktl_${"0".repeat(39)}2`);
    sockets[1]?.drop();
    await scheduler.advance(1999);
    expect(sockets).toHaveLength(2);
    await scheduler.advance(1);
    expect(sockets).toHaveLength(3);
    // a hello followed by a quick drop doesn't reset the backoff
    sockets[2]?.receive(hello);
    sockets[2]?.drop();
    await scheduler.advance(3999);
    expect(sockets).toHaveLength(3);
    await scheduler.advance(1);
    expect(sockets).toHaveLength(4);
    // a connection that stayed open long enough does
    sockets[3]?.receive(hello);
    await scheduler.advance(10_000);
    sockets[3]?.drop();
    await scheduler.advance(1000);
    expect(sockets).toHaveLength(5);
    expect(states).toContain("open");
  });

  it("pings, and reconnects when nothing answers", async () => {
    const { live, scheduler, sockets } = setup();
    live.start();
    await scheduler.advance(0);
    sockets[0]?.receive(hello);
    await scheduler.advance(30_000);
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: "ping" })]);
    sockets[0]?.receive({ type: "pong" });
    await scheduler.advance(30_000);
    expect(sockets[0]?.sent).toHaveLength(2);
    await scheduler.advance(5000);
    expect(sockets[0]?.closed).toBe(true);
    expect(live.state).toBe("reconnecting");
    await scheduler.advance(1000);
    expect(sockets).toHaveLength(2);
  });

  it("retries when the socket can't even be created", async () => {
    const scheduler = new ManualScheduler();
    const { connect, sockets } = fakeSockets();
    let refusals = 1;
    const live = new LiveConnection({
      api: createApiClient({
        baseUrl: "https://api.test",
        auth: { kind: "session" },
        scheduler,
        fetch: () =>
          Promise.resolve(response(201, { ticket: `ktl_${"1".repeat(40)}`, expiresAt: now })),
      }),
      workspaceId,
      scheduler,
      random: () => 1,
      connect: (url, handlers) => {
        if (refusals-- > 0) throw new Error("SyntaxError: bad URL");
        return connect(url, handlers);
      },
      onMessage: () => undefined,
    });
    live.start();
    await scheduler.advance(0);
    expect(live.state).toBe("reconnecting");
    await scheduler.advance(1000);
    expect(sockets).toHaveLength(1);
  });

  it("retries when the ticket request fails on the network", async () => {
    const { live, scheduler, sockets } = setup([() => new TypeError("offline")]);
    live.start();
    await scheduler.advance(0);
    expect(sockets).toHaveLength(0);
    expect(live.state).toBe("reconnecting");
    await scheduler.advance(1000);
    expect(sockets).toHaveLength(1);
  });

  it("stops for good when access is gone", async () => {
    const revokedTicket = setup([
      () => response(401, { error: { code: "token_revoked", message: "revoked" } }),
    ]);
    revokedTicket.live.start();
    await revokedTicket.scheduler.advance(0);
    expect(revokedTicket.live.state).toBe("revoked");
    expect(revokedTicket.scheduler.pending).toBe(0);

    const { live, scheduler, sockets, messages } = setup();
    live.start();
    await scheduler.advance(0);
    sockets[0]?.receive({ type: "revoked" });
    expect(messages.at(-1)).toEqual({ type: "revoked" });
    expect(live.state).toBe("revoked");
    sockets[0]?.drop();
    await scheduler.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("stops when asked, and a late close changes nothing", async () => {
    const { live, scheduler, sockets } = setup();
    live.start();
    await scheduler.advance(0);
    live.stop();
    expect(sockets[0]?.closed).toBe(true);
    sockets[0]?.handlers.onClose(1000);
    await scheduler.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(live.state).toBe("stopped");
  });
});

describe("sockets", () => {
  it("maps http(s) to ws(s)", () => {
    expect(webSocketBase("https://api.knowtarium.com")).toBe("wss://api.knowtarium.com");
    expect(webSocketBase("http://localhost:8787")).toBe("ws://localhost:8787");
  });

  it("adapts a standard WebSocket", () => {
    const created: FakeStandard[] = [];
    class FakeStandard implements StandardWebSocket {
      onopen: unknown = null;
      onmessage: unknown = null;
      onclose: unknown = null;
      onerror: unknown = null;
      readonly sent: string[] = [];
      closed = false;
      constructor(readonly url: string) {
        created.push(this);
      }
      send(data: string): void {
        this.sent.push(data);
      }
      close(): void {
        this.closed = true;
      }
    }
    const received: string[] = [];
    const closes: number[] = [];
    const socket = standardSocketFactory(FakeStandard)("wss://x/live", {
      onOpen: () => undefined,
      onMessage: (text) => received.push(text),
      onClose: (code) => closes.push(code),
      onError: () => undefined,
    });
    const raw = created[0];
    (raw?.onmessage as (event: { data: unknown }) => void)({ data: '{"type":"pong"}' });
    (raw?.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(1) });
    (raw?.onclose as (event: { code: number }) => void)({ code: 1001 });
    socket.send("ping");
    socket.close();
    expect(received).toEqual(['{"type":"pong"}']);
    expect(closes).toEqual([1001]);
    expect(raw?.sent).toEqual(["ping"]);
    expect(raw?.closed).toBe(true);
  });
});
