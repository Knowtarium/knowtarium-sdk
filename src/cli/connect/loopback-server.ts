import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  LOOPBACK_CONNECT_PATH,
  LOOPBACK_HOST,
  type LoopbackResponse,
} from "../../protocol/index.js";

/** The largest delivery the endpoint reads (a delivery is a few kilobytes). */
const MAX_BODY_BYTES = 256 * 1024;
/** How long a request may take to send its headers, and all of it (a delivery is tiny). */
const HEADERS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** The CLI's loopback endpoint, listening until closed. */
export interface LoopbackServer {
  readonly port: number;
  close(): Promise<void>;
}

function corsHeaders(origin: string, request: IncomingMessage): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
    // Private Network Access: a public web page may only call 127.0.0.1 after this answer
    ...(request.headers["access-control-request-private-network"] === "true"
      ? { "Access-Control-Allow-Private-Network": "true" }
      : {}),
  };
}

function send(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: unknown,
): void {
  response.writeHead(status, {
    ...headers,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    "Cache-Control": "no-store",
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Listens on a random port of 127.0.0.1 for the browser's connect delivery. Only the web app's
 * origin may call it: the CORS preflight is answered for that origin alone (with Private Network
 * Access), and a request from any other origin, path or method is refused, as is one whose
 * `Host` isn't `127.0.0.1:<port>` (DNS rebinding). Slow requests are cut off. `handle` decides
 * on each delivery; the flow accepts exactly one.
 */
export function startLoopbackServer(options: {
  readonly appOrigin: string;
  /** Decides on a delivery; `after` runs once the answer has been sent. */
  readonly handle: (
    body: unknown,
  ) => Promise<{ readonly answer: LoopbackResponse; readonly after?: () => void }>;
}): Promise<LoopbackServer> {
  let expectedHost = "";
  const server = createServer((request, response) => {
    if (request.headers.host !== expectedHost) {
      send(response, 421, {});
      return;
    }
    const origin = request.headers.origin;
    const path = (request.url ?? "").split("?")[0];
    if (path !== LOOPBACK_CONNECT_PATH) {
      send(response, 404, {});
      return;
    }
    if (origin !== options.appOrigin) {
      send(response, 403, {});
      return;
    }
    const cors = corsHeaders(options.appOrigin, request);
    if (request.method === "OPTIONS") {
      send(response, 204, cors);
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, cors);
      return;
    }
    void (async () => {
      const text = await readBody(request);
      if (text === null) {
        send(response, 413, cors);
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        send(response, 400, cors, { ok: false, error: "invalid_payload" });
        return;
      }
      const { answer, after } = await options.handle(body);
      if (after !== undefined) response.once("close", after);
      send(response, answer.ok ? 200 : 400, cors, answer);
    })().catch(() => {
      send(response, 500, cors, { ok: false, error: "invalid_payload" });
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      expectedHost = `${LOOPBACK_HOST}:${String(port)}`;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
