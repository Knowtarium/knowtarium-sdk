import type { z } from "zod";

import {
  AUTHORIZATION_HEADER,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  needsCsrfHeader,
  pathFor,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  RAW_BYTES,
  routeKey,
  type RouteBase,
} from "../../protocol/index.js";
import { RequestValidationError } from "../errors/index.js";
import type { AuthMode } from "./types.js";

/** A request ready for `fetch`, before the fixed options are added. */
export interface BuiltRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array<ArrayBuffer>;
}

/** The loose shape `ApiClient.call` hands over after its typed signature. */
export interface LooseInput {
  readonly params?: Readonly<Record<string, string | number>> | undefined;
  readonly query?: Readonly<Record<string, unknown>> | undefined;
  readonly headers?: Readonly<Record<string, unknown>> | undefined;
  readonly body?: unknown;
}

function issuePath(error: z.ZodError): (string | number)[] {
  const path = error.issues[0]?.path ?? [];
  return path.map((key) => (typeof key === "symbol" ? String(key.description) : key));
}

/** Refuses a route this auth mode can't call, before anything is sent. */
export function assertAuth(route: RouteBase, auth: AuthMode): void {
  const refused =
    (route.auth === "session" && auth.kind !== "session") ||
    (route.auth === "agent" && auth.kind !== "agent");
  if (refused) throw new RequestValidationError(routeKey(route), "auth");
}

/** The path with its parameters validated against the protocol's ID schemas, then filled. */
export function buildPath(route: RouteBase, params: LooseInput["params"]): string {
  const result = route.params.safeParse(params ?? {});
  if (!result.success) {
    throw new RequestValidationError(routeKey(route), "params", issuePath(result.error));
  }
  return pathFor(route, (params ?? {}) as Record<string, string | number>);
}

/** `?name=value&...` from a validated query, or an empty string. */
export function buildQuery(route: RouteBase, query: LooseInput["query"]): string {
  if (route.query === null || query === undefined) return "";
  const result = route.query.safeParse(query);
  if (!result.success) {
    throw new RequestValidationError(routeKey(route), "query", issuePath(result.error));
  }
  const pairs = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

function routeHeaders(route: RouteBase, input: LooseInput["headers"]): Record<string, string> {
  if (route.headers === null) return {};
  const result = route.headers.safeParse(input ?? {});
  if (!result.success) {
    throw new RequestValidationError(routeKey(route), "headers", issuePath(result.error));
  }
  // only the headers the route declares, as the caller wrote them (the schema may transform)
  const headers: Record<string, string> = {};
  for (const key of Object.keys(route.headers.shape)) {
    const value = input?.[key];
    if (typeof value === "string") headers[key] = value;
  }
  return headers;
}

function encodeBody(
  route: RouteBase,
  body: unknown,
): { body?: string | Uint8Array<ArrayBuffer>; contentType?: string } {
  if (route.body === null) return {};
  if (route.body === RAW_BYTES) {
    if (!(body instanceof Uint8Array)) throw new RequestValidationError(routeKey(route), "body");
    return { body: new Uint8Array(body), contentType: RAW_BYTES.contentType };
  }
  const result = (route.body as z.ZodType).safeParse(body);
  if (!result.success) {
    throw new RequestValidationError(routeKey(route), "body", issuePath(result.error));
  }
  return { body: JSON.stringify(result.data), contentType: "application/json" };
}

function authHeaders(auth: AuthMode): Record<string, string> {
  if (auth.kind === "session") return {};
  const token = typeof auth.token === "function" ? auth.token() : auth.token;
  return { [AUTHORIZATION_HEADER]: `Bearer ${token}` };
}

/**
 * Builds a request: validated path, query, route headers and body, then the caller's extra
 * headers, then the fixed ones last (protocol version, the CSRF header on every request that
 * isn't a GET, the bearer token), so nothing a caller passes can replace them.
 */
export function buildRequest(
  route: RouteBase,
  input: LooseInput,
  options: {
    readonly baseUrl: string;
    readonly auth: AuthMode;
    readonly extraHeaders: Readonly<Record<string, string>>;
  },
): BuiltRequest {
  assertAuth(route, options.auth);
  const url = options.baseUrl + buildPath(route, input.params) + buildQuery(route, input.query);
  const { body, contentType } = encodeBody(route, input.body);
  const fixed: Record<string, string> = {
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    ...(needsCsrfHeader(route.method) ? { [CSRF_HEADER]: CSRF_HEADER_VALUE } : {}),
    ...authHeaders(options.auth),
  };
  // later layers win; header names are case-insensitive, so the key is the lowercase name
  const headers = new Map<string, [string, string]>();
  const layers = [
    options.extraHeaders,
    routeHeaders(route, input.headers),
    contentType === undefined ? {} : { "Content-Type": contentType },
    fixed,
  ];
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer))
      headers.set(name.toLowerCase(), [name, value]);
  }
  return {
    url,
    method: route.method,
    headers: Object.fromEntries(headers.values()),
    ...(body === undefined ? {} : { body }),
  };
}
