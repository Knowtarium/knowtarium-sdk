import {
  type BoxKeyPair,
  createKeyring,
  fromBase64Url,
  isCryptoError,
  unwrapSignedWorkspaceKey,
  type WorkspaceKey,
  type WorkspaceKeyring,
  workspaceKeyCommitment,
} from "../../crypto/index.js";
import { routes, type WrappedWorkspaceKey } from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { VaultError } from "../errors/index.js";
import type { TrustState } from "./trust.js";
import { currentGenerationState } from "./rotation.js";
import { toSignedEnvelope } from "./verify.js";

/** What opening a workspace's wrapped keys needs, all from sources the server can't swap. */
export interface KeyringOptions {
  readonly workspaceId: string;
  /** This client's X25519 keypair: the account's, or the CLI's own. */
  readonly recipient: BoxKeyPair;
  /**
   * The owner's Ed25519 public key: the web app's own account key, or the key the CLI pinned at
   * connect. Never `Workspace.ownerSignPublicKey` from a server response.
   */
  readonly ownerSigningPublicKey: Uint8Array;
  /** The owner's account ID, when known. */
  readonly ownerAccountId?: string;
  readonly trust: TrustState;
}

function openOne(record: WrappedWorkspaceKey, options: KeyringOptions): WorkspaceKey {
  if (record.signed.envelope.type !== "wrapped_key") {
    throw new VaultError("untrusted_signature", "the wrapped key carries another envelope");
  }
  if (record.signed.envelope.generation !== record.keyGeneration) {
    throw new VaultError("untrusted_signature", "the wrapped key's generation doesn't match");
  }
  try {
    return unwrapSignedWorkspaceKey(
      {
        wrapped: fromBase64Url(record.encWorkspaceKey),
        signed: toSignedEnvelope(record.signed),
        signedGeneration: toSignedEnvelope(record.signedGeneration),
      },
      options.recipient,
      {
        ownerSigningPublicKey: options.ownerSigningPublicKey,
        workspaceId: options.workspaceId,
        ...(options.ownerAccountId === undefined ? {} : { ownerAccountId: options.ownerAccountId }),
      },
    );
  } catch (error) {
    if (isCryptoError(error)) {
      throw new VaultError("untrusted_signature", "a wrapped key failed verification");
    }
    throw error;
  }
}

/**
 * Verifies and opens a workspace's wrapped keys (from `listKeys`): every copy must carry the
 * owner's valid `wrapped_key` and `key_generation` signatures for this client's own public key
 * (decision 14), or nothing is opened. Each key must match its generation's signed
 * `keyCommitment`, one generation has one key (two different ones are refused), and the
 * commitment is pinned per generation in `trust` (`pin_mismatch` for another key later). The
 * newest generation must not be older than the highest this device has seen (`rollback`), and it
 * becomes the new high-water mark.
 */
export async function openWorkspaceKeyring(
  records: readonly WrappedWorkspaceKey[],
  options: KeyringOptions,
): Promise<WorkspaceKeyring> {
  const mine = records.filter((record) => record.workspaceId === options.workspaceId);
  const keys = new Map<number, WorkspaceKey>();
  for (const record of mine) {
    const key = openOne(record, options);
    const known = keys.get(key.generation);
    if (
      known !== undefined &&
      workspaceKeyCommitment(known, options.workspaceId) !==
        workspaceKeyCommitment(key, options.workspaceId)
    ) {
      throw new VaultError("untrusted_signature", "two different keys for one key generation");
    }
    keys.set(key.generation, key);
  }
  if (keys.size === 0) throw new VaultError("missing_key", "no wrapped key for this workspace");
  for (const key of keys.values()) {
    await options.trust.acceptKeyCommitment(
      options.workspaceId,
      key.generation,
      workspaceKeyCommitment(key, options.workspaceId),
    );
  }
  const keyring = createKeyring(keys.values());
  await options.trust.acceptKeyGeneration(options.workspaceId, keyring.current.generation);
  return keyring;
}

/** The verified keyring of one workspace, fetched once and again after a rotation. */
export interface KeyProvider {
  /** The keyring, fetched on first use. Fine for reading. */
  get(): Promise<WorkspaceKeyring>;
  /** Fetches the wrapped keys again (after `keys_rotated` or an unknown generation). */
  refresh(): Promise<WorkspaceKeyring>;
  /**
   * The keyring for encrypting anything new (every write path: notes, comments, events, folder
   * names). Refuses (`rotation_pending`) while the current generation still holds a revoked
   * agent, so a device whose rotation is stuck never keeps writing under a key that agent holds.
   */
  forWriting(): Promise<WorkspaceKeyring>;
}

/**
 * A `KeyProvider` over `listKeys`; concurrent refreshes share one request. For the owner (the
 * answer lists every recipient's copy), every refresh also checks the current generation's
 * owner-signed recipient set against the revocations (`currentGenerationState`): this device
 * remembers every valid signed revocation it sees, and `forWriting` refuses while the current
 * generation still holds a revoked key (also one another owner device, which hadn't seen the
 * revocation, rotated back in).
 */
export function createKeyProvider(api: ApiClient, options: KeyringOptions): KeyProvider {
  let current: Promise<WorkspaceKeyring> | undefined;
  let inflight: Promise<WorkspaceKeyring> | undefined;
  let pending = false;
  const fetchAndOpen = async (): Promise<WorkspaceKeyring> => {
    const { data } = await api.call(routes.listKeys);
    const keyring = await openWorkspaceKeyring(data.workspaceKeys, options);
    pending =
      data.recipients !== undefined &&
      (
        await currentGenerationState(data.recipients, data.revocations ?? [], {
          workspaceId: options.workspaceId,
          generation: keyring.current.generation,
          ownerSigningPublicKey: options.ownerSigningPublicKey,
          ...(options.ownerAccountId === undefined
            ? {}
            : { ownerAccountId: options.ownerAccountId }),
          ownerBoxPublicKey: options.recipient.publicKey,
          trust: options.trust,
        })
      ).rotationPending;
    return keyring;
  };
  const refresh = (): Promise<WorkspaceKeyring> => {
    if (inflight !== undefined) return inflight;
    const next = fetchAndOpen().finally(() => {
      inflight = undefined;
    });
    inflight = next;
    current = next;
    next.catch(() => {
      if (current === next) current = undefined;
    });
    return next;
  };
  const get = () => current ?? refresh();
  return {
    get,
    refresh,
    forWriting: async () => {
      let keyring = await get();
      // another device may have rotated meanwhile: look again before refusing
      if (pending) keyring = await refresh();
      if (pending) {
        throw new VaultError(
          "rotation_pending",
          "rotation pending: the current key generation still holds a revoked agent",
        );
      }
      return keyring;
    },
  };
}
