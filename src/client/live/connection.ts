import {
  type ErrorCode,
  LIVE_PING_INTERVAL_SECONDS,
  parseServerMessage,
  pathFor,
  PROTOCOL_VERSION,
  routes,
  type ServerMessage,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { backoffDelay } from "../api/retry.js";
import { isSyncApiError } from "../errors/index.js";
import { type Scheduler, systemScheduler, type TimerHandle } from "../platform/timers.js";
import type { LiveSocket, SocketFactory } from "./socket.js";

/**
 * Where the live connection is: opening (asking for a ticket, then the socket), open (the server
 * said hello), waiting to reconnect, stopped by the caller, or refused for good (the token or
 * session lost access).
 */
export type LiveState = "connecting" | "open" | "reconnecting" | "stopped" | "revoked";

/** What a live connection needs; the timing options have defaults. */
export interface LiveOptions {
  readonly api: ApiClient;
  readonly workspaceId: string;
  readonly connect: SocketFactory;
  /** Every valid message from the server. */
  readonly onMessage: (message: ServerMessage) => void;
  readonly onState?: (state: LiveState) => void;
  readonly scheduler?: Scheduler;
  readonly random?: () => number;
  /** First reconnect delay; doubles per failed attempt, with jitter. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** How often to ping; defaults to the protocol's interval. */
  readonly pingIntervalMs?: number;
  /** How long to wait for any message after a ping before reconnecting. */
  readonly pongTimeoutMs?: number;
  /**
   * How long a connection must stay open after the server's hello before the backoff starts over
   * (30 s), so a server that accepts and drops at once can't make the client hammer it.
   */
  readonly stableAfterMs?: number;
}

/** Errors that mean access is gone, so reconnecting would only fail again. */
const FATAL_CODES: readonly ErrorCode[] = [
  "unauthenticated",
  "token_revoked",
  "forbidden",
  "scope_denied",
  "not_found",
];

/** `https://api` to `wss://api`, `http://localhost` to `ws://localhost`. */
export function webSocketBase(baseUrl: string): string {
  return baseUrl.replace(/^http(s?):\/\//i, (_match, secure: string) => `ws${secure}://`);
}

/**
 * The live ping connection of one workspace: gets a single-use ticket (`createLiveTicket`), opens
 * the socket with it, pings to notice dead connections, and reconnects with backoff until
 * stopped or revoked. It passes on the server's messages; pulling the changes is up to the
 * caller.
 */
export class LiveConnection {
  private socket: LiveSocket | undefined;
  private current: LiveState = "stopped";
  private attempt = 0;
  /** When the current connection said hello, if it did. */
  private openedAt: number | undefined;
  private generation = 0;
  private readonly timers = new Set<TimerHandle>();
  private readonly scheduler: Scheduler;

  constructor(private readonly options: LiveOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  get state(): LiveState {
    return this.current;
  }

  /** Connects, or connects again after `stop` or a revocation (for example after signing in). */
  start(): void {
    if (this.current !== "stopped" && this.current !== "revoked") return;
    this.attempt = 0;
    void this.open();
  }

  /** Closes the socket and stops reconnecting. */
  stop(): void {
    this.shutdown("stopped");
  }

  private setState(state: LiveState): void {
    if (this.current === state) return;
    this.current = state;
    this.options.onState?.(state);
  }

  private later(ms: number, run: () => void): void {
    const handle = this.scheduler.setTimeout(() => {
      this.timers.delete(handle);
      run();
    }, ms);
    this.timers.add(handle);
  }

  private clearTimers(): void {
    for (const handle of this.timers) this.scheduler.clearTimeout(handle);
    this.timers.clear();
  }

  private shutdown(state: "stopped" | "revoked"): void {
    this.generation++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.setState(state);
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.setState("connecting");
    let ticket: string;
    try {
      const { data } = await this.options.api.call(routes.createLiveTicket, {
        params: { workspaceId: this.options.workspaceId },
      });
      ticket = data.ticket;
    } catch (error) {
      if (generation !== this.generation) return;
      if (isSyncApiError(error) && FATAL_CODES.includes(error.code)) {
        this.shutdown("revoked");
      } else {
        this.retry(generation);
      }
      return;
    }
    if (generation !== this.generation) return;
    const path = pathFor(routes.live, { workspaceId: this.options.workspaceId });
    const query = `?protocol=${String(PROTOCOL_VERSION)}&ticket=${encodeURIComponent(ticket)}`;
    try {
      this.socket = this.options.connect(webSocketBase(this.options.api.baseUrl) + path + query, {
        onOpen: () => undefined,
        onMessage: (text) => {
          if (generation === this.generation) this.receive(text, generation);
        },
        onClose: () => {
          if (generation === this.generation) this.retry(generation);
        },
        onError: () => undefined,
      });
    } catch {
      // the runtime refused to open the socket (bad URL, too many sockets): try again later
      this.retry(generation);
    }
  }

  private receive(text: string, generation: number): void {
    const message = parseServerMessage(text);
    if (message === null) return;
    this.clearTimers();
    if (message.type === "revoked") {
      this.options.onMessage(message);
      this.shutdown("revoked");
      return;
    }
    if (message.type === "hello") {
      this.openedAt = this.scheduler.now();
      this.setState("open");
    }
    this.schedulePing(generation);
    this.options.onMessage(message);
  }

  private schedulePing(generation: number): void {
    const interval = this.options.pingIntervalMs ?? LIVE_PING_INTERVAL_SECONDS * 1000;
    this.later(interval, () => {
      if (generation !== this.generation) return;
      this.socket?.send(JSON.stringify({ type: "ping" }));
      this.later(this.options.pongTimeoutMs ?? 10_000, () => {
        // no answer: the connection is dead even if the socket hasn't noticed
        if (generation === this.generation) this.retry(generation);
      });
    });
  }

  private retry(generation: number): void {
    if (generation !== this.generation) return;
    this.generation++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.setState("reconnecting");
    const stableAfter = this.options.stableAfterMs ?? 30_000;
    if (this.openedAt !== undefined && this.scheduler.now() - this.openedAt >= stableAfter) {
      this.attempt = 0;
    }
    this.openedAt = undefined;
    this.attempt++;
    const delay = backoffDelay(
      {
        maxAttempts: Infinity,
        baseDelayMs: this.options.baseDelayMs ?? 1000,
        maxDelayMs: this.options.maxDelayMs ?? 30_000,
        maxRetryAfterMs: 0,
      },
      this.attempt,
      this.options.random ?? Math.random,
    );
    this.later(delay, () => {
      void this.open();
    });
  }
}
