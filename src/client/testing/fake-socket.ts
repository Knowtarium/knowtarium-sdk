// A socket factory the tests drive by hand. Not exported.
import type { LiveSocket, SocketFactory, SocketHandlers } from "../live/index.js";

export interface FakeSocket extends LiveSocket {
  readonly url: string;
  readonly handlers: SocketHandlers;
  readonly sent: string[];
  closed: boolean;
  /** Delivers a message from the server. */
  receive(message: unknown): void;
  /** The server (or the network) drops the connection. */
  drop(code?: number): void;
}

/** A factory that records every socket it opens. */
export function fakeSockets(): { connect: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const connect: SocketFactory = (url, handlers) => {
    const socket: FakeSocket = {
      url,
      handlers,
      sent: [],
      closed: false,
      send(text) {
        this.sent.push(text);
      },
      close() {
        this.closed = true;
      },
      receive(message) {
        handlers.onMessage(JSON.stringify(message));
      },
      drop(code = 1006) {
        this.closed = true;
        handlers.onClose(code);
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { connect, sockets };
}
