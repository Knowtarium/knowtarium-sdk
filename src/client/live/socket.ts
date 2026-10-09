// A WebSocket seen through callbacks, so the live connection works with the browser's
// `WebSocket`, Node's global one, the `ws` package or a test double, without DOM types.

/** What a socket reports. */
export interface SocketHandlers {
  onOpen(): void;
  /** A text frame. */
  onMessage(text: string): void;
  onClose(code: number): void;
  onError(): void;
}

/** An open (or opening) socket. */
export interface LiveSocket {
  send(text: string): void;
  close(): void;
}

/** Opens a socket to `url` that reports to `handlers`. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => LiveSocket;

/** The part of a standard `WebSocket` the adapter touches. */
export interface StandardWebSocket {
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
  send(data: string): void;
  close(): void;
}

/** A `SocketFactory` over a standard `WebSocket` constructor (`globalThis.WebSocket` or `ws`). */
export function standardSocketFactory(
  WebSocketClass: new (url: string) => StandardWebSocket,
): SocketFactory {
  return (url, handlers) => {
    const socket = new WebSocketClass(url);
    socket.onopen = () => {
      handlers.onOpen();
    };
    socket.onmessage = (event: { data?: unknown }) => {
      if (typeof event.data === "string") handlers.onMessage(event.data);
    };
    socket.onclose = (event: { code?: unknown }) => {
      handlers.onClose(typeof event.code === "number" ? event.code : 1006);
    };
    socket.onerror = () => {
      handlers.onError();
    };
    return {
      send: (text) => {
        socket.send(text);
      },
      close: () => {
        socket.close();
      },
    };
  };
}
