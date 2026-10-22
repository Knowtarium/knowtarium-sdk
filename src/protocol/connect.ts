import { z } from "zod";

import { Ciphertext, EncKey, EncName, PublicKey, Signature } from "./ciphertext.js";
import { ExtensionInfo } from "./clips.js";
import { ConnectRequestId, ExtensionId, FolderId, TokenId, WorkspaceId } from "./ids.js";
import { KeyGeneration, Ok, secretSchema, SignedTimestamp, Timestamp } from "./primitives.js";
import { defineRoute } from "./route.js";
import {
  agentKeySigningFields,
  keyGenerationSigningFields,
  requiredSigningFields,
  Sha256,
} from "./signatures.js";
import { AgentPermission } from "./agent-scope.js";
import { AgentToken, TokenAccess } from "./tokens.js";

/*
 * Connecting a local agent (`npx knowtarium connect`). The server's part is small: it registers
 * the request, then the token and its scope, and stores the signed wrapped key (for rotation and
 * `listKeys`). On the primary path it never carries the token secret or the owner's signing key
 * to the CLI; the browser delivers those over the loopback (see loopback.ts).
 *
 * 1. The CLI registers a request (its version only) and gets a request ID and a poll secret.
 * 2. It opens `<app>/connect?request=<id>#<fragment>` (public key, loopback port, one-time
 *    secret; see loopback.ts). The server never sees the fragment.
 * 3. The person picks the scope and allows. The browser makes the token ID and secret, seals the
 *    workspace key for the key from the fragment, signs the wrapped copy (`wrapped_key`, whose
 *    `recipient` is the CLI's X25519 public key from the fragment, never the token ID) and
 *    approves here with the secret's SHA-256.
 * 4. The browser posts the delivery to the CLI's loopback endpoint.
 * 5. Only if that fails: the browser shows the confirmation code, derived from
 *    hash(CLI public key || owner signing public key), and the person confirms it matches the
 *    terminal BEFORE the browser calls `relayConnect`. The CLI collects the payload by polling,
 *    shows the same code, and accepts the payload only after the person confirms it there too.
 *
 * The CLI polls throughout, to learn about a denial or expiry and to collect a relayed payload.
 *
 * A browser extension (the web clipper) pairs over the same requests, expiry, poll secret, relay
 * and rate limits (`client: "extension"`; its version goes where the CLI's does). It can't listen
 * on a loopback, so delivery is always the relay; the confirmation code over its signing key and
 * the request ID (`extensionConfirmationCode`) is shown by the extension at once and matched in
 * the web app before Allow; the approval has its own route (`approveExtensionConnect`), which
 * creates the extension's row and token and no workspace key copy; and the relayed payload has
 * its own format (`ktextpar`, see `knowtarium/clip`). The `/connect` page and `approveConnect`
 * refuse an extension's request, and `approveExtensionConnect` a CLI's (400 `invalid_request`).
 */

/** The web app page an extension opens: `<app origin>/connect/extension?request=<id>#<fragment>`. */
export const EXTENSION_CONNECT_PAGE_PATH = "/connect/extension";

/** The web app page the CLI opens: `<app origin>/connect?request=<requestId>#<fragment>`. */
export const CONNECT_PAGE_PATH = "/connect";
export const CONNECT_REQUEST_TTL_SECONDS = 600;

/** Only the CLI that started the request knows it, so only it can collect the token. */
export const PollSecret = secretSchema("ktp");
export type PollSecret = z.infer<typeof PollSecret>;

export const CliVersion = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, { error: "Expected a semver version" });

/** `approved`: the token exists and delivery is up to the browser; `relayed`: a payload waits. */
export const ConnectStatus = z.enum([
  "pending",
  "approved",
  "relayed",
  "denied",
  "expired",
  "completed",
]);
export type ConnectStatus = z.infer<typeof ConnectStatus>;

/** Who started a connect request: the CLI, or a browser extension (the web clipper). */
export const ConnectClient = z.enum(["cli", "extension"]);
export type ConnectClient = z.infer<typeof ConnectClient>;

/** The CLI sends its version; an extension says so and sends its own (stored as the CLI's). */
export const StartConnectRequest = z.union([
  z.strictObject({ cliVersion: CliVersion }),
  z.strictObject({ client: z.literal("extension"), extensionVersion: CliVersion }),
]);
export type StartConnectRequest = z.infer<typeof StartConnectRequest>;

export const StartConnectResponse = z.object({
  requestId: ConnectRequestId,
  pollSecret: PollSecret,
  expiresAt: Timestamp,
  pollIntervalSeconds: z.int().positive(),
});
export type StartConnectResponse = z.infer<typeof StartConnectResponse>;

/**
 * What the connect page reads before the person allows (the key comes from the fragment).
 * `cliVersion` is the extension's version for an extension's request. Servers from before the web
 * clipper don't send `client`, which then reads as `cli`.
 */
export const ConnectRequestInfo = z.object({
  id: ConnectRequestId,
  client: ConnectClient.default("cli"),
  cliVersion: CliVersion,
  status: ConnectStatus,
  createdAt: Timestamp,
  expiresAt: Timestamp,
});
export type ConnectRequestInfo = z.infer<typeof ConnectRequestInfo>;

export const ConnectRequestResponse = z.object({ request: ConnectRequestInfo });
export type ConnectRequestResponse = z.infer<typeof ConnectRequestResponse>;

/**
 * Registers the token with its scope and stores the workspace key sealed for the CLI's public key
 * (from the fragment, sent as `publicKey`), signed as `wrapped_key` with `recipient` = that X25519
 * public key in base64url and `holder` = `tokenId`: the server rebuilds the envelope with
 * `publicKey` and `tokenId` and stores it as the token's key, so a later rotation seals for the
 * same key and token (`prepareConnectGeneration` in knowtarium/client builds the key fields). The browser made
 * the token secret; the server gets only its SHA-256 (of the whole `kta_...` string in UTF-8).
 *
 * When the fragment carried the CLI's Ed25519 key (protocol 2), the browser sends it as
 * `signPublicKey` with the owner's `agent_key` signature on `{tokenId, signPublicKey,
 * policyRevision}` (`agentKeySignedAt`, `agentKeySignature`), where `policyRevision` is the
 * workspace's current agent policy revision, which the browser read and verified first. The
 * server rebuilds the envelope with its own current revision (a policy change in between fails
 * the signature; the browser fetches the policy and approves again), verifies it, stores the key
 * as the token's `signPublicKey` and returns the signed record in `listKeys` (`agentKeys`) and in
 * the delivery. All three fields or none: without them (an older CLI) the token has no signing
 * key and can only propose.
 *
 * Protocol 3: `permissions` (none by default; only with `read-write`) and the owner's
 * `agent_scope` at revision 1 over the access, folders and permissions chosen
 * (`scopeSignedAt`, `scopeSignature`; both or neither). The server stores the token at scope
 * revision 1 with that signature. Without them (an older web tab) the token is stored at
 * revision 0 with no permissions, and permissions without a signature are refused.
 */
export const ApproveConnectRequest = z
  .strictObject({
    tokenId: TokenId,
    tokenSecretSha256: Sha256,
    workspaceId: WorkspaceId,
    access: TokenAccess,
    folderIds: z.array(FolderId).max(100),
    /** The agent's name, an `agent_name` blob bound to `tokenId` (`encryptAgentName`). */
    encName: EncName,
    publicKey: PublicKey,
    keyGeneration: KeyGeneration,
    encWorkspaceKey: EncKey,
    ...requiredSigningFields,
    /**
     * The owner's `key_generation` for `keyGeneration` again, now naming the new agent's public key
     * too (`recipientsHash` over every copy of the generation); it replaces the stored one.
     */
    ...keyGenerationSigningFields,
    ...agentKeySigningFields,
    /** What the agent may do on top of `read-write`, each once (protocol 3). */
    permissions: z.array(AgentPermission).optional(),
    /** The owner's `agent_scope` at revision 1 (protocol 3). */
    scopeSignedAt: SignedTimestamp.optional(),
    scopeSignature: Signature.optional(),
  })
  .refine((value) => (value.scopeSignedAt === undefined) === (value.scopeSignature === undefined), {
    error: "Send scopeSignedAt and scopeSignature together, or neither",
  })
  .refine(
    (value) =>
      (value.permissions ?? []).length === 0 ||
      (value.access === "read-write" &&
        value.scopeSignature !== undefined &&
        new Set(value.permissions).size === value.permissions?.length),
    { error: "Permissions need read-write access and a signed scope, each once" },
  )
  .refine(
    (value) => {
      const present = [value.signPublicKey, value.agentKeySignedAt, value.agentKeySignature];
      return (
        present.every((field) => field === undefined) ||
        present.every((field) => field !== undefined)
      );
    },
    { error: "Send signPublicKey, agentKeySignedAt and agentKeySignature together, or none" },
  );
export type ApproveConnectRequest = z.infer<typeof ApproveConnectRequest>;

export const ApproveConnectResponse = z.object({ token: AgentToken });
export type ApproveConnectResponse = z.infer<typeof ApproveConnectResponse>;

/**
 * The owner allows an extension (the web clipper): the web app made the extension's ID and its
 * `kte_` token secret (the server gets only the secret's SHA-256), encrypted its name (an
 * `extension_name` blob bound to `extensionId`) and signed `extension_key` over `extensionId` and
 * the extension's Ed25519 key from the fragment (`keySignedAt`, `keySignature`). Refusals: 404
 * `not_found` (an unknown request, or a workspace the account doesn't own), 410 `expired`, 409
 * `already_exists` (decided already), 400 `invalid_request` (a CLI's request), 409 `inbox_not_set`
 * (no `inbox_key` yet) and 400 `invalid_signature`.
 */
export const ApproveExtensionConnectRequest = z.strictObject({
  extensionId: ExtensionId,
  tokenSecretSha256: Sha256,
  workspaceId: WorkspaceId,
  encName: EncName,
  signPublicKey: PublicKey,
  keySignedAt: SignedTimestamp,
  keySignature: Signature,
});
export type ApproveExtensionConnectRequest = z.infer<typeof ApproveExtensionConnectRequest>;

export const ApproveExtensionConnectResponse = z.object({ extension: ExtensionInfo });
export type ApproveExtensionConnectResponse = z.infer<typeof ApproveExtensionConnectResponse>;

export const PollConnectRequest = z.strictObject({ pollSecret: PollSecret });
export type PollConnectRequest = z.infer<typeof PollConnectRequest>;

/**
 * Fallback only: a `ConnectDelivery` (loopback.ts) as JSON, sealed for the CLI's public key and
 * authenticated with a key derived from the fragment's one-time secret (both from
 * `knowtarium/crypto`), so the server can neither read it nor make one the CLI accepts. The
 * server stores it until the CLI collects it.
 */
export const RelayConnectRequest = z.strictObject({ encRelayPayload: Ciphertext });
export type RelayConnectRequest = z.infer<typeof RelayConnectRequest>;

/** The relayed payload is returned once; the request is `completed` after that. */
export const PollConnectResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), pollIntervalSeconds: z.int().positive() }),
  /** Allowed; the delivery comes over the loopback, or a relay may still follow. */
  z.object({ status: z.literal("approved"), pollIntervalSeconds: z.int().positive() }),
  z.object({ status: z.literal("relayed"), encRelayPayload: Ciphertext }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("completed") }),
]);
export type PollConnectResponse = z.infer<typeof PollConnectResponse>;

export const connectRoutes = {
  startConnect: defineRoute({
    method: "POST",
    path: "/connect-requests",
    auth: "none",
    summary:
      "The CLI or an extension registers a connect request (its keys stay in the URL fragment)",
    body: StartConnectRequest,
    response: StartConnectResponse,
    status: 201,
  }),
  getConnect: defineRoute({
    method: "GET",
    path: "/connect-requests/:requestId",
    auth: "session",
    summary: "The connect page reads the request's status",
    response: ConnectRequestResponse,
  }),
  approveConnect: defineRoute({
    method: "POST",
    path: "/connect-requests/:requestId/approval",
    auth: "session",
    summary: "Allow: register the scoped token and store the signed key sealed for the CLI",
    body: ApproveConnectRequest,
    response: ApproveConnectResponse,
  }),
  approveExtensionConnect: defineRoute({
    method: "POST",
    path: "/connect-requests/:requestId/extension-approval",
    auth: "session",
    summary: "Allow an extension: register its token and the owner-signed key of the web clipper",
    body: ApproveExtensionConnectRequest,
    response: ApproveExtensionConnectResponse,
  }),
  relayConnect: defineRoute({
    method: "POST",
    path: "/connect-requests/:requestId/relay",
    auth: "session",
    summary: "Fallback: hand the server a sealed delivery for the CLI to collect",
    body: RelayConnectRequest,
    response: Ok,
  }),
  denyConnect: defineRoute({
    method: "POST",
    path: "/connect-requests/:requestId/denial",
    auth: "session",
    summary: "Refuse the request",
    response: Ok,
  }),
  pollConnect: defineRoute({
    method: "POST",
    path: "/connect-requests/:requestId/poll",
    auth: "none",
    summary:
      "The CLI polls for the decision or a relayed payload, proving itself with the poll secret",
    body: PollConnectRequest,
    response: PollConnectResponse,
  }),
};
