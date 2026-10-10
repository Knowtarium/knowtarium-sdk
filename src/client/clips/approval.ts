import {
  sealExtensionPairing,
  sha256,
  toBase64Url,
  type ExtensionPairing,
  type WorkspaceKey,
} from "../../crypto/index.js";
import { utf8Encode } from "../../crypto/encoding.js";
import { sodium } from "../../crypto/sodium.js";
import {
  type ApproveExtensionConnectRequest,
  type ConnectRequestId,
  type ExtensionId,
  type ExtensionInfo,
  routes,
  type SignedInboxKey,
  type WorkspaceId,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { VaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { encryptExtensionName } from "../vault/content.js";
import { signExtensionKey, type SigningTime } from "../vault/envelopes.js";
import type { KeyProvider } from "../vault/keys.js";
import type { Signer } from "../vault/signer.js";

/*
 * The web app's side of pairing an extension (the web clipper), once the person matched the code
 * (`extensionConfirmationCode`) and allowed, with the inbox key current (`ensureInboxKey`): the
 * extension's ID and `kte_` token, the owner's `extension_key` over the extension's signing key
 * from the fragment, its name encrypted (`extension_name`), the approval, then the pairing payload
 * sealed under the fragment's one-time secret and relayed for the extension to collect.
 */

/** Bytes of randomness in an extension's token secret (after `kte_`). */
const TOKEN_SECRET_BYTES = 32;

/** What the approval needs besides the owner: the request, the fragment and what to hand over. */
export interface ExtensionApprovalDetails extends SigningTime {
  readonly requestId: ConnectRequestId;
  readonly workspaceId: WorkspaceId;
  /** The extension's Ed25519 public key and the one-time secret, from the pairing link's fragment. */
  readonly signPublicKey: Uint8Array;
  readonly secret: Uint8Array;
  /** The name the person gives the extension ("Chrome on macOS"), encrypted for the API. */
  readonly name: string;
  /** The decrypted workspace name, for the popup. */
  readonly workspaceName: string;
  /** The latest owner-signed inbox key (`ensureInboxKey`). */
  readonly inboxKey: SignedInboxKey;
  /** The decrypted names of the inbox folder's direct subfolders (at most 200 are sent). */
  readonly categories: readonly string[];
}

/** A prepared approval: the request body, the payload to seal, and the token it holds. */
export interface PreparedExtensionApproval {
  readonly extensionId: ExtensionId;
  /** The extension's token (`kte_...`): it travels only inside the sealed pairing payload. */
  readonly tokenSecret: string;
  readonly request: ApproveExtensionConnectRequest;
  readonly pairing: ExtensionPairing;
}

/**
 * Builds an extension's approval (session, the workspace owner): a new `ext_` ID and `kte_`
 * token (the API gets only the base64url SHA-256 of the whole token in UTF-8), the owner's
 * `extension_key`, the name encrypted with the current key, and the pairing payload.
 */
export function prepareExtensionApproval(
  signer: Signer,
  key: WorkspaceKey,
  details: ExtensionApprovalDetails,
): PreparedExtensionApproval {
  const { workspaceId, inboxKey } = details;
  if (inboxKey.envelope.workspaceId !== workspaceId) {
    throw new VaultError("untrusted_signature", "the inbox key is another workspace's");
  }
  const extensionId: ExtensionId = newId("ext");
  const tokenSecret = `kte_${toBase64Url(sodium().randombytes_buf(TOKEN_SECRET_BYTES))}`;
  const signed = signExtensionKey(signer, {
    workspaceId,
    extensionId,
    signPublicKey: details.signPublicKey,
    ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
  });
  const request: ApproveExtensionConnectRequest = {
    extensionId,
    tokenSecretSha256: toBase64Url(sha256(utf8Encode(tokenSecret))),
    workspaceId,
    encName: encryptExtensionName(key, { workspaceId, extensionId }, details.name),
    signPublicKey: toBase64Url(details.signPublicKey),
    keySignedAt: signed.signedAt,
    keySignature: signed.signature,
  };
  const pairing: ExtensionPairing = {
    token: tokenSecret,
    extensionId,
    accountId: signer.accountId,
    workspaceId,
    workspaceName: details.workspaceName,
    ownerSigningPublicKey: signer.signing.publicKey,
    extensionKey: {
      envelope: {
        type: "extension_key",
        accountId: signer.accountId,
        workspaceId,
        createdAt: signed.signedAt,
        extensionId,
        signPublicKey: request.signPublicKey,
      },
      signature: signed.signature,
    },
    inboxKey,
    categories: details.categories,
  };
  return { extensionId, tokenSecret, request, pairing };
}

/**
 * Approves an extension and relays its pairing payload (session, the workspace owner): prepares
 * the approval with the current key (`prepareExtensionApproval`), sends it, checks the API
 * registered exactly this extension and key, then seals the payload for the extension and relays
 * it (`relayConnect`). Returns the extension as listed.
 */
export async function approveExtension(
  api: ApiClient,
  flow: { readonly signer: Signer; readonly keys: KeyProvider },
  details: ExtensionApprovalDetails,
): Promise<{ readonly extension: ExtensionInfo }> {
  const keys = await flow.keys.forWriting();
  const prepared = prepareExtensionApproval(flow.signer, keys.current, details);
  const params = { requestId: details.requestId };
  const { data } = await api.call(routes.approveExtensionConnect, {
    params,
    body: prepared.request,
  });
  if (
    data.extension.extensionId !== prepared.extensionId ||
    data.extension.signPublicKey !== prepared.request.signPublicKey
  ) {
    throw new VaultError("untrusted_signature", "the server registered another extension");
  }
  const sealed = sealExtensionPairing(prepared.pairing, {
    secret: details.secret,
    signPublicKey: details.signPublicKey,
  });
  await api.call(routes.relayConnect, {
    params,
    body: { encRelayPayload: toBase64Url(sealed) },
  });
  return { extension: data.extension };
}
