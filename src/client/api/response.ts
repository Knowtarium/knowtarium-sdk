import type { z } from "zod";

import {
  type ApiError,
  ETAG_HEADER,
  parseErrorBody,
  parseVersionTag,
  RAW_BYTES,
  RETRY_AFTER_HEADER,
  type RouteBase,
  routeKey,
  WEBSOCKET,
} from "../../protocol/index.js";
import { utf8Decode } from "../../crypto/encoding.js";
import { InvalidResponseError, SyncApiError } from "../errors/index.js";
import type { FetchResponse } from "../platform/fetch.js";

/** A validated successful response. */
export interface ReadResponse {
  readonly data: unknown;
  readonly status: number;
  readonly version: number | null;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function responseVersion(route: RouteBase, response: FetchResponse): number | null {
  if (route.responseHeaders === null) return null;
  const values: Record<string, string> = {};
  for (const key of Object.keys(route.responseHeaders.shape)) {
    const value = response.headers.get(key);
    if (value !== null) values[key] = value;
  }
  if (!route.responseHeaders.safeParse(values).success) {
    throw new InvalidResponseError(routeKey(route), "headers");
  }
  return parseVersionTag(response.headers.get(ETAG_HEADER));
}

/** Reads a 2xx response: raw bytes as they are, JSON validated against the route's schema. */
export function readSuccess(
  route: RouteBase,
  response: FetchResponse,
  bytes: Uint8Array,
): ReadResponse {
  if (response.status !== route.status && response.status !== 200) {
    throw new InvalidResponseError(routeKey(route), `status ${String(response.status)}`);
  }
  const version = responseVersion(route, response);
  if (route.response === RAW_BYTES) return { data: bytes, status: response.status, version };
  if (route.response === WEBSOCKET) throw new InvalidResponseError(routeKey(route), "websocket");
  const result = (route.response as z.ZodType).safeParse(parseJson(bytes));
  if (!result.success) throw new InvalidResponseError(routeKey(route), "body");
  return { data: result.data, status: response.status, version };
}

/** A made-up error body for an error response that doesn't carry one (a proxy's page). */
function fallbackError(response: FetchResponse): ApiError | null {
  const message = `HTTP ${String(response.status)}`;
  const status = response.status;
  if (status === 401) return { code: "unauthenticated", message };
  if (status === 403) return { code: "forbidden", message };
  if (status === 404) return { code: "not_found", message };
  if (status === 410) return { code: "expired", message };
  if (status === 413) return { code: "payload_too_large", message };
  if (status === 429) {
    const seconds = Number(response.headers.get(RETRY_AFTER_HEADER) ?? "0");
    return {
      code: "rate_limited",
      message,
      retryAfterSeconds: Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 0,
    };
  }
  if (status === 503) return { code: "unavailable", message };
  if (status >= 500 && status < 600) return { code: "internal", message };
  return null;
}

/** The error for a non-2xx response: the protocol error it carries, mapped to `SyncApiError`. */
export function readFailure(route: RouteBase, response: FetchResponse, bytes: Uint8Array): Error {
  const detail = parseErrorBody(parseJson(bytes))?.error ?? fallbackError(response);
  if (detail === null) {
    return new InvalidResponseError(routeKey(route), `status ${String(response.status)}`);
  }
  return new SyncApiError(response.status, detail, routeKey(route));
}
