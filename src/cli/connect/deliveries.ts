import { timingSafeEqual } from "node:crypto";

import {
  type BoxKeyPair,
  fromBase64Url,
  isCryptoError,
  openConnectPayload,
  type SigningKeyPair,
  toBase64Url,
  unwrapSignedWorkspaceKey,
  type WorkspaceKey,
} from "../../crypto/index.js";
import {
  type AgentToken,
  AgentTokenSecret,
  LoopbackRequest,
  type LoopbackResponse,
  routes,
  type SignedAgentKey,
} from "../../protocol/index.js";
import {
  createApiClient,
  type FetchLike,
  toSignedEnvelope,
  verifiedAgentKeys,
  verifyAgentKey,
} from "../../client/index.js";
import type { Connection } from "../storage/credentials.js";

/**
 * What the CLI made for this connect: its X25519 keypair, its Ed25519 keypair for direct writes
 * (the public half goes in the link as `signPublicKey`) and the one-time secret in the link.
 */
export interface ConnectIdentity {
  readonly keyPair: BoxKeyPair;
  readonly signing: SigningKeyPair;
  readonly secret: Uint8Array;
}

/**
 * The owner's `agent_key` for this connection, checked: it must verify under the owner key the
 * delivery brought (and the CLI pins), for this workspace, and name this token and this CLI's own
 * signing key. `"mismatch"` when it doesn't: the link's `signPublicKey` was swapped, or the
 * record is forged, so the delivery is refused (and the token revoked) rather than saved.
 */
function checkAgentKey(
  signed: SignedAgentKey,
  identity: ConnectIdentity,
  owner: { readonly publicKey: Uint8Array; readonly accountId: string },
  token: AgentToken,
): SignedAgentKey | "mismatch" {
  if (!tokenKeyIsOwn(token, identity)) return "mismatch";
  const key = verifyAgentKey(signed, owner, token.workspaceId);
  if (key?.tokenId !== token.id) return "mismatch";
  if (!sameSecret(key.publicKey, identity.signing.publicKey)) return "mismatch";
  return signed;
}

/** Whether the token's signing key, when it names one, is this CLI's own. */
function tokenKeyIsOwn(token: AgentToken, identity: ConnectIdentity): boolean {
  return (
    token.signPublicKey == null ||
    sameSecret(fromBase64UrlSafe(token.signPublicKey), identity.signing.publicKey)
  );
}

/** A verified delivery: the connection to save and the workspace key it unlocks. */
export interface Delivered {
  readonly connection: Connection;
  readonly workspaceKey: WorkspaceKey;
  /** The code over the CLI key and the owner key, as the browser shows it. */
  readonly confirmationCode: string;
  readonly via: "loopback" | "relay";
}

function sameSecret(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function connectionOf(
  token: AgentToken,
  details: {
    tokenSecret: string;
    ownerId: string;
    ownerSignPublicKey: string;
    keyPair: BoxKeyPair;
    signing: SigningKeyPair;
    agentKey: SignedAgentKey | undefined;
    apiUrl: string;
    now: Date;
  },
): Connection {
  return {
    apiUrl: details.apiUrl,
    workspaceId: token.workspaceId,
    tokenId: token.id,
    tokenSecret: AgentTokenSecret.parse(details.tokenSecret),
    access: token.access,
    folderIds: token.folderIds,
    agentPrivateKey: toBase64Url(details.keyPair.privateKey),
    ownerId: details.ownerId as Connection["ownerId"],
    ownerSignPublicKey: details.ownerSignPublicKey,
    connectedAt: details.now.toISOString(),
    agentSignPrivateKey: toBase64Url(details.signing.privateKey),
    ...(details.agentKey === undefined ? {} : { agentKey: details.agentKey }),
  };
}

/**
 * Checks a loopback delivery: the one-time secret from the link (compared in constant time), the
 * shape, and the owner's signatures on the wrapped key, which must be sealed for this CLI's own
 * key and for the token's workspace. The owner's signing key comes from the delivery itself (the
 * browser that holds the account), never from the server; it is pinned from here on. An
 * `agent_key`, when sent, must verify under that key and name this token and this CLI's signing
 * key; without one the connection can only propose. A wrong one is refused with `revoke` set: the
 * token the browser made for it, which the caller revokes.
 */
export function acceptLoopbackDelivery(
  body: unknown,
  identity: ConnectIdentity,
  details: { readonly apiUrl: string; readonly now: Date },
):
  | { ok: true; delivered: Delivered }
  | {
      ok: false;
      answer: LoopbackResponse;
      revoke?: Pick<Connection, "apiUrl" | "tokenId" | "tokenSecret">;
    } {
  const parsed = LoopbackRequest.safeParse(body);
  if (!parsed.success) {
    const secret = (body as { secret?: unknown } | null)?.secret;
    const secretOk =
      typeof secret === "string" && sameSecret(fromBase64UrlSafe(secret), identity.secret);
    return { ok: false, answer: { ok: false, error: secretOk ? "invalid_payload" : "bad_secret" } };
  }
  const delivery = parsed.data;
  if (!sameSecret(fromBase64Url(delivery.secret), identity.secret)) {
    return { ok: false, answer: { ok: false, error: "bad_secret" } };
  }
  const record = delivery.wrappedKey;
  if (record.workspaceId !== delivery.token.workspaceId) {
    return { ok: false, answer: { ok: false, error: "invalid_payload" } };
  }
  const ownerKey = fromBase64Url(delivery.ownerSignPublicKey);
  let workspaceKey: WorkspaceKey;
  try {
    workspaceKey = unwrapSignedWorkspaceKey(
      {
        wrapped: fromBase64Url(record.encWorkspaceKey),
        signed: toSignedEnvelope(record.signed),
        signedGeneration: toSignedEnvelope(record.signedGeneration),
      },
      identity.keyPair,
      {
        ownerSigningPublicKey: ownerKey,
        ownerAccountId: delivery.ownerId,
        workspaceId: record.workspaceId,
      },
    );
  } catch (error) {
    if (isCryptoError(error)) return { ok: false, answer: { ok: false, error: "bad_signature" } };
    throw error;
  }
  const agentKey =
    delivery.agentKey === undefined
      ? undefined
      : checkAgentKey(
          delivery.agentKey,
          identity,
          { publicKey: ownerKey, accountId: delivery.ownerId },
          delivery.token,
        );
  if (agentKey === "mismatch") {
    return {
      ok: false,
      answer: { ok: false, error: "agent_key_mismatch" },
      revoke: {
        apiUrl: details.apiUrl,
        tokenId: delivery.token.id,
        tokenSecret: delivery.tokenSecret,
      },
    };
  }
  return {
    ok: true,
    delivered: {
      connection: connectionOf(delivery.token, {
        tokenSecret: delivery.tokenSecret,
        ownerId: delivery.ownerId,
        ownerSignPublicKey: delivery.ownerSignPublicKey,
        keyPair: identity.keyPair,
        signing: identity.signing,
        agentKey,
        ...details,
      }),
      workspaceKey,
      confirmationCode: "",
      via: "loopback",
    },
  };
}

function fromBase64UrlSafe(text: string): Uint8Array {
  try {
    return fromBase64Url(text);
  } catch {
    return new Uint8Array();
  }
}

/**
 * A relayed delivery refused after its token was known, so the caller revokes that token:
 * `mismatch` when the token or the owner's `agent_key` names another signing key than this CLI's,
 * `failed` when checking it failed (a `listKeys` that didn't answer, say).
 */
export class RelayedDeliveryError extends Error {
  override readonly name = "RelayedDeliveryError";

  constructor(
    readonly reason: "mismatch" | "failed",
    readonly connection: Pick<Connection, "apiUrl" | "tokenId" | "tokenSecret">,
    options?: { cause?: unknown },
  ) {
    super(
      reason === "mismatch"
        ? "The workspace owner vouched for another signing key than this computer's."
        : "The relayed connection couldn't be checked.",
      options,
    );
  }
}

/**
 * Opens a relayed delivery with the crypto connect helpers (authenticated by the link's secret,
 * owner signatures verified, key unwrapped), then asks the sync API which token it is, with the
 * token itself. The sealed payload carries no `agent_key`, so when the token has a signing key
 * the CLI reads the owner's `agent_key` from `listKeys` and keeps it only if it verifies under the
 * owner key from the payload and names this token and this CLI's own key (records that don't
 * verify, or none, leave the connection propose-only). A token or a verified record naming
 * another key throws `RelayedDeliveryError` (`mismatch`), and so does a failed check once the
 * token is known (`failed`): the caller revokes the token either way. The caller shows the
 * confirmation code and asks the person before accepting.
 */
export async function openRelayedDelivery(
  sealed: string,
  identity: ConnectIdentity,
  details: { readonly apiUrl: string; readonly fetch: FetchLike; readonly now: Date },
): Promise<Delivered> {
  const opened = openConnectPayload(fromBase64Url(sealed), identity);
  const tokenSecret = AgentTokenSecret.parse(opened.token);
  const api = createApiClient({
    baseUrl: details.apiUrl,
    fetch: details.fetch,
    auth: { kind: "agent", token: tokenSecret },
  });
  const { data } = await api.call(routes.getCurrentToken);
  if (data.token.workspaceId !== opened.workspaceId) {
    throw new Error("The relayed key is for another workspace than the token.");
  }
  const revocable = { apiUrl: details.apiUrl, tokenId: data.token.id, tokenSecret };
  if (!tokenKeyIsOwn(data.token, identity)) throw new RelayedDeliveryError("mismatch", revocable);
  let agentKey: SignedAgentKey | undefined;
  if (data.token.signPublicKey != null) {
    const owner = { publicKey: opened.ownerSigningPublicKey, accountId: opened.ownerAccountId };
    let keys;
    try {
      ({ data: keys } = await api.call(routes.listKeys));
    } catch (error) {
      throw new RelayedDeliveryError("failed", revocable, { cause: error });
    }
    const vouched = verifiedAgentKeys(keys, owner, opened.workspaceId).get(data.token.id) ?? [];
    const own = vouched.find((key) => sameSecret(key.publicKey, identity.signing.publicKey));
    if (own === undefined && vouched.length > 0) {
      throw new RelayedDeliveryError("mismatch", revocable);
    }
    agentKey = own?.signed;
  }
  return {
    connection: connectionOf(data.token, {
      tokenSecret,
      ownerId: opened.ownerAccountId,
      ownerSignPublicKey: toBase64Url(opened.ownerSigningPublicKey),
      keyPair: identity.keyPair,
      signing: identity.signing,
      agentKey,
      apiUrl: details.apiUrl,
      now: details.now,
    }),
    workspaceKey: opened.workspaceKey,
    confirmationCode: opened.confirmationCode,
    via: "relay",
  };
}
