import type { AbortSignalLike } from "../platform/abort.js";
import type { z } from "zod";

import type {
  PathParamNames,
  PathParamValues,
  RawBytes,
  ResponseBody,
  RouteBase,
} from "../../protocol/index.js";

/**
 * How the client authenticates. `session` is the browser: Better Auth's httpOnly session cookie
 * goes along (`credentials: "include"`) and every request that isn't a GET carries
 * `Knowtarium-Request: 1`. `agent` is the CLI: `Authorization: Bearer kta_...`, no cookies.
 */
export type AuthMode =
  | { readonly kind: "session" }
  | {
      readonly kind: "agent";
      /** The agent token secret (`kta_...`), or a function that reads it when needed. */
      readonly token: string | (() => string);
    };

type ParamsInput<R extends RouteBase> = [PathParamNames<R["path"]>] extends [never]
  ? { readonly params?: undefined }
  : { readonly params: PathParamValues<R["path"]> };

type QueryInput<R extends RouteBase> = R["query"] extends z.ZodObject
  ? { readonly query?: z.output<R["query"]> }
  : { readonly query?: undefined };

type HeadersInput<R extends RouteBase> = R["headers"] extends z.ZodObject
  ? object extends z.input<R["headers"]>
    ? { readonly headers?: z.input<R["headers"]> }
    : { readonly headers: z.input<R["headers"]> }
  : { readonly headers?: undefined };

type BodyInput<R extends RouteBase> = R["body"] extends z.ZodType
  ? { readonly body: z.input<R["body"]> }
  : R["body"] extends RawBytes
    ? { readonly body: Uint8Array }
    : { readonly body?: undefined };

/** Options every call takes. */
export interface CallOptions {
  /**
   * Whether the request may be sent again after a network failure or a 5xx. GET requests always
   * may. Set it for creates that carry a client-made ID (the server answers a repeat with the
   * original result); leave it off for writes whose repeat would answer differently.
   */
  readonly idempotent?: boolean;
  /** Cancels the call (retries and waits included); it then fails with a `NetworkError`. */
  readonly signal?: AbortSignalLike;
  /** Milliseconds each attempt may take, response body included; 0 means no limit. */
  readonly timeoutMs?: number;
}

/**
 * What a call takes: the route's path parameters (validated against the protocol ID schemas),
 * query, route headers (keys in lowercase, as the route declares them) and body (JSON as the
 * route's schema takes it, or raw ciphertext bytes).
 */
export type CallInput<R extends RouteBase> = ParamsInput<R> &
  QueryInput<R> &
  HeadersInput<R> &
  BodyInput<R> &
  CallOptions;

/** The arguments of `ApiClient.call` after the route: the input is optional when nothing is required. */
export type CallArgs<R extends RouteBase> =
  object extends CallInput<R> ? [input?: CallInput<R>] : [input: CallInput<R>];

/** A successful response, validated against the route's schemas. */
export interface ApiResult<R extends RouteBase> {
  /** The parsed JSON body, or the raw bytes for a raw route. */
  readonly data: ResponseBody<R>;
  readonly status: number;
  /** The note version from the `ETag` header, on routes that send one; otherwise null. */
  readonly version: number | null;
}
