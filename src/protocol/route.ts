import { z } from "zod";

import { isParamName, PARAM_SCHEMAS, type ParamName } from "./params.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who may call a route: `none` (public), `session` (Better Auth's session cookie), `agent` (an
 * agent token as a bearer token) or `any` (either).
 */
export type RouteAuth = "none" | "session" | "agent" | "any";

/** A body sent or returned as raw bytes (`application/octet-stream`), not JSON. */
export const RAW_BYTES = { kind: "raw-bytes", contentType: "application/octet-stream" } as const;
export type RawBytes = typeof RAW_BYTES;

/** The response of a WebSocket upgrade route; the messages are in `live.ts`. */
export const WEBSOCKET = { kind: "websocket" } as const;
export type WebSocketUpgrade = typeof WEBSOCKET;

export type RequestBodySpec = z.ZodType | RawBytes | null;
export type ResponseBodySpec = z.ZodType | RawBytes | WebSocketUpgrade;
export type FieldsSchema = z.ZodObject | null;

/** The `:name` parameters of a path template, for example `"workspaceId" | "noteId"`. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<Rest>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** Values for the parameters of a path template, as `pathFor` takes them. */
export type PathParamValues<P extends string> = Record<PathParamNames<P>, string | number>;

type ParamsShape<P extends string> = {
  [K in PathParamNames<P> & ParamName]: (typeof PARAM_SCHEMAS)[K];
};

/**
 * What every route has, whatever its types. Beyond its own schemas, every request sends
 * `Knowtarium-Protocol-Version`, and every request that isn't a GET also sends
 * `Knowtarium-Request: 1` (see headers.ts).
 */
export interface RouteBase {
  readonly method: HttpMethod;
  /** A path template with `:name` parameters, in the syntax Hono uses. */
  readonly path: string;
  readonly auth: RouteAuth;
  readonly summary: string;
  /** Path parameters, parsed from strings. */
  readonly params: z.ZodObject;
  /** Query string parameters, parsed from strings. */
  readonly query: FieldsSchema;
  /** Request headers the route reads (keys in lowercase), besides auth and the protocol header. */
  readonly headers: FieldsSchema;
  readonly body: RequestBodySpec;
  readonly response: ResponseBodySpec;
  /** Response headers the route sets (keys in lowercase). */
  readonly responseHeaders: FieldsSchema;
  /** The status of a successful response. */
  readonly status: 101 | 200 | 201;
  /**
   * True on the one route where an agent signs with its own key (`writeNoteAsAgent`): the server
   * lets the agent's signing headers through instead of refusing them as it does on every other
   * route (only people sign elsewhere).
   */
  readonly agentSigns: boolean;
}

export interface Route<
  M extends HttpMethod,
  P extends string,
  B extends RequestBodySpec,
  R extends ResponseBodySpec,
  Q extends FieldsSchema,
  H extends FieldsSchema,
> extends RouteBase {
  readonly method: M;
  readonly path: P;
  readonly params: z.ZodObject<ParamsShape<P>>;
  readonly query: Q;
  readonly headers: H;
  readonly body: B;
  readonly response: R;
}

export interface RouteSpec<
  M extends HttpMethod,
  P extends string,
  B extends RequestBodySpec,
  R extends ResponseBodySpec,
  Q extends FieldsSchema,
  H extends FieldsSchema,
> {
  method: M;
  path: P;
  auth: RouteAuth;
  summary: string;
  body?: B;
  response: R;
  query?: Q;
  headers?: H;
  responseHeaders?: z.ZodObject;
  status?: RouteBase["status"];
  /** Set only on an `auth: "agent"` route whose request the agent signs (see `RouteBase`). */
  agentSigns?: true;
}

function paramsSchema(path: string): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const [, name = ""] of path.matchAll(/:([A-Za-z]+)/g)) {
    if (!isParamName(name)) throw new Error(`${path}: unknown path parameter :${name}`);
    shape[name] = PARAM_SCHEMAS[name];
  }
  return z.strictObject(shape);
}

/** Declares a route; its path parameters are typed from the path template. */
export function defineRoute<
  const M extends HttpMethod,
  const P extends string,
  R extends ResponseBodySpec,
  B extends RequestBodySpec = null,
  Q extends FieldsSchema = null,
  H extends FieldsSchema = null,
>(spec: RouteSpec<M, P, B, R, Q, H>): Route<M, P, B, R, Q, H> {
  if (spec.agentSigns === true && spec.auth !== "agent") {
    throw new Error(`${spec.path}: only an agent route can let the agent sign`);
  }
  return {
    method: spec.method,
    path: spec.path,
    auth: spec.auth,
    summary: spec.summary,
    params: paramsSchema(spec.path) as z.ZodObject<ParamsShape<P>>,
    query: (spec.query ?? null) as Q,
    headers: (spec.headers ?? null) as H,
    body: (spec.body ?? null) as B,
    response: spec.response,
    responseHeaders: spec.responseHeaders ?? null,
    status: spec.status ?? 200,
    agentSigns: spec.agentSigns ?? false,
  };
}

/** Fills a route's path template: `pathFor(routes.getWorkspace, { workspaceId })`. */
export function pathFor<P extends string>(route: { path: P }, params: PathParamValues<P>): string {
  const values = params as Record<string, string | number | undefined>;
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${route.path}: missing path parameter :${name}`);
    return encodeURIComponent(String(value));
  });
}

type BodyValue<S> = S extends z.ZodType
  ? z.output<S>
  : S extends RawBytes
    ? Uint8Array
    : S extends WebSocketUpgrade
      ? never
      : undefined;

/** The parsed JSON body a route takes (`Uint8Array` for raw bytes, `undefined` for none). */
export type RequestBody<R extends RouteBase> = BodyValue<R["body"]>;
/** The parsed JSON body a route returns (`Uint8Array` for raw bytes). */
export type ResponseBody<R extends RouteBase> = BodyValue<R["response"]>;
/** A route's parsed path parameters. */
export type RouteParams<R extends RouteBase> = z.output<R["params"]>;
/** A route's parsed query parameters. */
export type RouteQuery<R extends RouteBase> = BodyValue<R["query"]>;
/** A route's parsed request headers. */
export type RouteHeaders<R extends RouteBase> = BodyValue<R["headers"]>;
