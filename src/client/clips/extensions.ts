import { fromBase64Url, type SignedEnvelope, verifyEnvelope } from "../../crypto/index.js";
import {
  type ClipSummaryResponse,
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

/** The paired extensions, split by whether the owner's `extension_key` over each verifies. */
export interface ExtensionRows {
  /** Those whose key the owner vouched for, by ID: their clips are checked against that key. */
  readonly verified: Map<ExtensionId, VerifiedExtension>;
  /** Those listed whose `extension_key` doesn't verify: a filer rejects their clips. */
  readonly unvouched: ReadonlySet<ExtensionId>;
}

/**
 * The workspace's paired extensions, each checked: its `extension_key` must verify under the
 * owner's key (from a source the server can't swap). A filer rejects (`bad_signature`) the clips
 * of a listed extension whose key doesn't verify, and leaves waiting the clips of one not listed
 * at all (paired since the list was read).
 */
export async function fetchExtensionRows(
  api: ApiClient,
  details: {
    readonly workspaceId: WorkspaceId;
    readonly owner: TrustedSigner & { readonly accountId: string };
  },
): Promise<ExtensionRows> {
  const { data } = await api.call(routes.listExtensions, {
    params: { workspaceId: details.workspaceId },
  });
  const verified = new Map<ExtensionId, VerifiedExtension>();
  const unvouched = new Set<ExtensionId>();
  for (const info of data.extensions) {
    const signed = extensionKeyEnvelope(info, {
      workspaceId: details.workspaceId,
      ownerAccountId: details.owner.accountId,
    });
    if (!verifyEnvelope(signed, details.owner.publicKey)) {
      unvouched.add(info.extensionId);
      continue;
    }
    verified.set(info.extensionId, {
      extensionId: info.extensionId,
      signPublicKey: fromBase64Url(info.signPublicKey),
      revokedAt: info.revokedAt,
      info,
    });
  }
  return { verified, unvouched };
}

/**
 * The workspace's paired extensions whose `extension_key` verifies under the owner's key, by ID
 * (`fetchExtensionRows` without the ones that don't verify, whose clips a filer rejects).
 */
export async function fetchExtensions(
  api: ApiClient,
  details: {
    readonly workspaceId: WorkspaceId;
    readonly owner: TrustedSigner & { readonly accountId: string };
  },
): Promise<Map<ExtensionId, VerifiedExtension>> {
  return (await fetchExtensionRows(api, details)).verified;
}

/** The workspace's clip queue: how many clips wait, how many are leased, the oldest's time. */
export async function fetchClipSummary(
  api: ApiClient,
  workspaceId: WorkspaceId,
): Promise<ClipSummaryResponse> {
  const { data } = await api.call(routes.clipSummary, { params: { workspaceId } });
  return data;
}
