import { deriveInboxKeyPair, toBase64Url, verifyEnvelopeFor, wipe } from "../../crypto/index.js";
import { routes, type SignedInboxKey, type WorkspaceId } from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { isSyncApiError, VaultError } from "../errors/index.js";
import { signInboxKey } from "../vault/envelopes.js";
import type { Signer } from "../vault/signer.js";
import type { KeyProvider } from "../vault/keys.js";
import { toSignedEnvelope, type TrustedSigner } from "../vault/verify.js";

/*
 * The workspace's inbox key (the web clipper): the X25519 key pair derived from each workspace key
 * generation (`deriveInboxKeyPair`), whose public half the owner signs in `inbox_key` with the
 * inbox folder. The server keeps every revision and serves the latest. An owner device signs a new
 * revision (`ensureInboxKey`) at the first pairing, right after a rotation was accepted, on open
 * when the latest is for an older generation (a rotation that stopped in between), and when the
 * inbox folder had to be made again (pass its ID). Every filer reads the latest one, verifies it
 * under the owner key it trusts and derives the key again (`fetchInboxKey`).
 */

/**
 * The workspace's latest inbox key, verified under the owner's key (from a source the server
 * can't swap); null when the workspace has no inbox. Throws `untrusted_signature` for one that
 * doesn't verify or names another workspace or signer.
 */
export async function fetchInboxKey(
  api: ApiClient,
  details: { readonly workspaceId: WorkspaceId; readonly owner: TrustedSigner },
): Promise<SignedInboxKey | null> {
  const { data } = await api.call(routes.getInboxKey, {
    params: { workspaceId: details.workspaceId },
  });
  const signed = data.inboxKey;
  if (signed === null) return null;
  const ok = verifyEnvelopeFor(toSignedEnvelope(signed), details.owner.publicKey, {
    type: "inbox_key",
    workspaceId: details.workspaceId,
    ...(details.owner.accountId === undefined ? {} : { accountId: details.owner.accountId }),
  });
  if (!ok) throw new VaultError("untrusted_signature", "the inbox key isn't the owner's");
  return signed;
}

/** What `ensureInboxKey` needs: the owner's session, signer and verified keys. */
export interface InboxKeyFlow {
  readonly workspaceId: WorkspaceId;
  /** The workspace owner (session); the inbox key is signed with the account's key. */
  readonly signer: Signer;
  readonly keys: KeyProvider;
}

/** What `ensureInboxKey` did. */
export interface EnsuredInboxKey {
  /** `none`: no inbox and no folder given; `unchanged`: the latest is current; `signed`: a new one. */
  readonly status: "none" | "unchanged" | "signed";
  readonly inboxKey: SignedInboxKey | null;
}

/**
 * Makes the latest `inbox_key` the current generation's derived key for the inbox folder
 * (`folderId`, else the latest's folder), signing the next revision when it isn't (session, the
 * workspace owner). Does nothing for a workspace without an inbox unless `folderId` names one.
 * Uses the key `forWriting` gives, so it never signs a generation that still holds a revoked
 * agent (`rotation_pending`). A revision signed meanwhile by another device (409 `conflict`) or a
 * newer generation (`stale_key_generation`) reads everything again once.
 */
export async function ensureInboxKey(
  api: ApiClient,
  flow: InboxKeyFlow,
  options: { readonly folderId?: string } = {},
): Promise<EnsuredInboxKey> {
  const { workspaceId, signer } = flow;
  const owner = { publicKey: signer.signing.publicKey, accountId: signer.accountId };
  for (let attempt = 0; ; attempt++) {
    const latest = await fetchInboxKey(api, { workspaceId, owner });
    const folderId = options.folderId ?? latest?.envelope.folderId;
    if (folderId === undefined) return { status: "none", inboxKey: null };
    let keyring = await flow.keys.forWriting();
    if (latest !== null && latest.envelope.generation > keyring.current.generation) {
      await flow.keys.refresh();
      keyring = await flow.keys.forWriting();
      if (latest.envelope.generation > keyring.current.generation) {
        throw new VaultError("missing_key", "the inbox key names a generation this device lacks");
      }
    }
    const derived = deriveInboxKeyPair(keyring.current);
    wipe(derived.privateKey);
    const publicKey = toBase64Url(derived.publicKey);
    if (
      latest !== null &&
      latest.envelope.generation === derived.generation &&
      latest.envelope.publicKey === publicKey &&
      latest.envelope.folderId === folderId
    ) {
      return { status: "unchanged", inboxKey: latest };
    }
    const baseRevision = latest?.envelope.revision ?? 0;
    const action = signInboxKey(signer, {
      workspaceId,
      baseRevision,
      generation: derived.generation,
      publicKey: derived.publicKey,
      folderId,
    });
    try {
      const { data } = await api.call(routes.putInboxKey, {
        params: { workspaceId },
        body: {
          baseRevision,
          generation: derived.generation,
          publicKey,
          folderId: folderId as SignedInboxKey["envelope"]["folderId"],
          signedAt: action.signedAt,
          signature: action.signature,
        },
      });
      const stored = data.inboxKey;
      if (
        stored.signature !== action.signature ||
        stored.envelope.revision !== baseRevision + 1 ||
        stored.envelope.publicKey !== publicKey
      ) {
        throw new VaultError("untrusted_signature", "the server stored another inbox key");
      }
      return { status: "signed", inboxKey: stored };
    } catch (error) {
      const retry =
        isSyncApiError(error, "conflict") || isSyncApiError(error, "stale_key_generation");
      if (!retry || attempt > 0) throw error;
      if (isSyncApiError(error, "stale_key_generation")) await flow.keys.refresh();
    }
  }
}
