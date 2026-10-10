import { fromBase64Url, type SignedEnvelope, verifyEnvelope } from "../../crypto/index.js";
import {
  type ExtensionId,
  type ExtensionInfo,
  routes,
  type WorkspaceId,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import type { TrustedSigner } from "../vault/verify.js";

/** A paired extension whose signing key the owner vouched for (`extension_key`), verified. */
export interface VerifiedExtension {
  readonly extensionId: ExtensionId;
  /** The extension's Ed25519 public key, from the verified envelope. */
  readonly signPublicKey: Uint8Array;
  /** When it was revoked (the server's clock), or null. */
  readonly revokedAt: string | null;
  /** The listed record, for its name (`decryptExtensionName`) and times. */
  readonly info: ExtensionInfo;
}

/**
 * The `extension_key` an extension's row stands for, rebuilt as the server does: the owner's
 * account, the workspace, the extension ID and its key, signed at `keySignedAt`.
 */
export function extensionKeyEnvelope(
  info: ExtensionInfo,
  details: { readonly workspaceId: WorkspaceId; readonly ownerAccountId: string },
): SignedEnvelope {
  return {
    version: 1,
    envelope: {
      type: "extension_key",
      accountId: details.ownerAccountId,
      workspaceId: details.workspaceId,
      extensionId: info.extensionId,
      signPublicKey: info.signPublicKey,
      createdAt: info.keySignedAt,
    },
    signature: info.keySignature,
  };
}

/**
 * The workspace's paired extensions whose `extension_key` verifies under the owner's key (from a
 * source the server can't swap), by ID. A row whose signature doesn't verify is left out, so its
 * clips are refused (`bad_signature`).
 */
export async function fetchExtensions(
  api: ApiClient,
  details: {
    readonly workspaceId: WorkspaceId;
    readonly owner: TrustedSigner & { readonly accountId: string };
  },
): Promise<Map<ExtensionId, VerifiedExtension>> {
  const { data } = await api.call(routes.listExtensions, {
    params: { workspaceId: details.workspaceId },
  });
  const verified = new Map<ExtensionId, VerifiedExtension>();
  for (const info of data.extensions) {
    const signed = extensionKeyEnvelope(info, {
      workspaceId: details.workspaceId,
      ownerAccountId: details.owner.accountId,
    });
    if (!verifyEnvelope(signed, details.owner.publicKey)) continue;
    verified.set(info.extensionId, {
      extensionId: info.extensionId,
      signPublicKey: fromBase64Url(info.signPublicKey),
      revokedAt: info.revokedAt,
      info,
    });
  }
  return verified;
}
