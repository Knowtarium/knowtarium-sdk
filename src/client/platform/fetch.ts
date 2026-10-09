// The slice of the Fetch API the client uses, typed by hand: `src/` has neither DOM nor Node types
// on purpose. The global `fetch` of browsers, Node, Workers and Deno fits `FetchLike`, and so does
// any wrapper or test double with the same shape.

/** The request options the client passes to `fetch`. */
export interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  /** JSON text or raw ciphertext. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
  /** Always `"no-store"`: nothing from the sync API goes into an HTTP cache. */
  readonly cache: "no-store";
  /** Always `"error"`: a redirect never carries credentials or ciphertext anywhere else. */
  readonly redirect: "error";
  /** `"include"` for the browser session cookie, `"omit"` with a bearer token. */
  readonly credentials: "include" | "omit";
  /**
   * The runtime's `AbortSignal` for this attempt (fired on timeout or when the caller aborts).
   * Typed `any` because `src/` can't name the DOM type, and the runtime's `fetch` must accept it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly signal?: any;
}

/** The response fields the client reads. */
export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A `fetch` function: the runtime's global one, or a wrapper or a test double. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;
