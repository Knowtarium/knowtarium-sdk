import { z } from "zod";

import { PublicKey } from "./ciphertext.js";
import { AccountId, ConnectRequestId } from "./ids.js";
import { WrappedWorkspaceKey } from "./keys.js";
import { Base64Url, base64UrlLength } from "./primitives.js";
import { SignedAgentKey } from "./signatures.js";
import { AgentToken, AgentTokenSecret } from "./tokens.js";

/*
 * Key delivery in the connect flow goes around the server. The CLI listens on a random port on
 * 127.0.0.1 and opens `<app>/connect?request=<id>#<fragment>`, the fragment holding its public
 * key, the port and a one-time secret (browsers never send the fragment to a server). After the
 * person allows, the browser POSTs a `LoopbackRequest` straight to
 * `http://127.0.0.1:<port>/knowtarium/connect`: the agent token secret, the token, the owner's
 * signing public key and the signed wrapped key. The CLI checks the one-time secret, pins the
 * owner's signing key from this payload (never the server's copy), verifies the wrapped key's
 * signature and unwraps it.
 *
 * The CLI's endpoint must answer the CORS preflight for the web app's origin, including Private
 * Network Access (`Access-Control-Allow-Private-Network: true`), accept one delivery and close.
 *
 * Fallback when the loopback is unreachable (an SSH session, a blocking browser): both sides show
 * a confirmation code derived from hash(CLI public key || owner signing public key)
 * (`knowtarium/crypto`). The browser relays only after the person confirms the code matches the
 * terminal: it seals a `ConnectDelivery` for the CLI's public key, authenticated with a key
 * derived from the fragment's one-time secret, and hands it to the server (`relayConnect`). The
 * CLI collects it by polling, checks it, and accepts it only after the person confirms the code in
 * the terminal as well.
 */

export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_CONNECT_PATH = "/knowtarium/connect";

/** The URL the browser posts the delivery to. */
export function loopbackConnectUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${String(port)}${LOOPBACK_CONNECT_PATH}`;
}

/** The one-time secret that proves the browser read the fragment (32 random bytes). */
export const LoopbackSecret = Base64Url.length(base64UrlLength(32));
export type LoopbackSecret = z.infer<typeof LoopbackSecret>;

/**
 * The URL fragment of the connect page: `publicKey=...&port=...&secret=...`, then
 * `&signPublicKey=...` from a protocol 2 CLI.
 */
export const ConnectFragment = z.strictObject({
  /** The CLI's X25519 public key, which the workspace key is sealed for. */
  publicKey: PublicKey,
  port: z.coerce.number().int().min(1024).max(65535),
  secret: LoopbackSecret,
  /**
   * The CLI's Ed25519 public key, which signs the agent's direct writes (`agent_edited`); the
   * owner vouches for it at `approveConnect` (`agent_key`). Absent from CLIs older than
   * protocol 2, whose tokens can only propose.
   */
  signPublicKey: PublicKey.optional(),
});
export type ConnectFragment = z.infer<typeof ConnectFragment>;

/** Writes the fragment (without the `#`). Every value is URL-safe as it is. */
export function formatConnectFragment(fragment: ConnectFragment): string {
  const text = `publicKey=${fragment.publicKey}&port=${String(fragment.port)}&secret=${fragment.secret}`;
  return fragment.signPublicKey === undefined
    ? text
    : `${text}&signPublicKey=${fragment.signPublicKey}`;
}

/** Reads a fragment (with or without the `#`); null when it is malformed or incomplete. */
export function parseConnectFragment(fragment: string): ConnectFragment | null {
  const entries: Record<string, string> = {};
  for (const part of fragment.replace(/^#/, "").split("&")) {
    const at = part.indexOf("=");
    if (at <= 0) return null;
    const key = part.slice(0, at);
    if (Object.hasOwn(entries, key)) return null;
    entries[key] = part.slice(at + 1);
  }
  const result = ConnectFragment.safeParse(entries);
  return result.success ? result.data : null;
}

/**
 * What the CLI needs to act for the agent: sent to the loopback endpoint, or sealed and relayed
 * in the fallback. `tokenSecret` is made in the browser; the server only holds its SHA-256.
 */
export const ConnectDelivery = z.strictObject({
  requestId: ConnectRequestId,
  tokenSecret: AgentTokenSecret,
  token: AgentToken,
  ownerId: AccountId,
  /** The key the CLI pins to verify the owner's signatures from now on. */
  ownerSignPublicKey: PublicKey,
  /**
   * The workspace key sealed for the CLI, with the owner's signed `wrapped_key` whose `recipient`
   * is the CLI's own X25519 public key (never the token ID); the CLI checks it is its own key.
   */
  wrappedKey: WrappedWorkspaceKey,
  /**
   * The owner's signed `agent_key` for this token and the CLI's own Ed25519 key, sent only when
   * the fragment carried `signPublicKey` (an older CLI, which refuses unknown fields, never gets
   * it). The CLI checks it under the pinned owner key and that it names its own key and token,
   * and keeps its `policyRevision` as the lowest agent policy revision it will ever accept.
   */
  agentKey: SignedAgentKey.optional(),
});
export type ConnectDelivery = z.infer<typeof ConnectDelivery>;

/** The body the browser posts to the loopback endpoint. */
export const LoopbackRequest = ConnectDelivery.extend({ secret: LoopbackSecret });
export type LoopbackRequest = z.infer<typeof LoopbackRequest>;

/**
 * The loopback endpoint's answer. `ok: true` comes only after the CLI has pinned the owner key and
 * saved the connection. `owner_changed`: this computer pinned a different owner key for the
 * workspace before. `save_failed`: the CLI couldn't store the connection. `agent_key_mismatch`
 * (protocol 2): the `agent_key` doesn't verify, or names another signing key or token than this
 * CLI's, so the link's `signPublicKey` was swapped or the record forged; tell the owner. In all
 * three cases the CLI has revoked the token it received, and the page says so (they are final:
 * a relay can't help).
 */
export const LoopbackResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    error: z.enum([
      "bad_secret",
      "invalid_payload",
      "bad_signature",
      "already_connected",
      "owner_changed",
      "save_failed",
      "agent_key_mismatch",
    ]),
  }),
]);
export type LoopbackResponse = z.infer<typeof LoopbackResponse>;
