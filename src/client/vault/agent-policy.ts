import { fromBase64Url, toBase64Url } from "../../crypto/index.js";
import {
  type AgentPolicy,
  type AgentPolicyFolder,
  agentPolicySha256,
  type AgentPolicyViewResult,
  type AgentWriteMode,
  resolveAgentPolicyView,
  routes,
  type SetAgentPolicyRequest,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { VaultError } from "../errors/index.js";
import { verifiedAgentKeys } from "./agent-keys.js";
import { signAgentKey, signAgentPolicy, type SigningTime } from "./envelopes.js";
import type { Signer } from "./signer.js";
import type { TrustState } from "./trust.js";
import { agentPolicySignatureVerifier } from "./verify.js";

/*
 * The agent policy as clients read and set it (protocol 2; the schema, the resolver and the
 * threat model are in knowtarium/protocol's agent-policy.ts). Every read is checked with
 * `resolveAgentPolicyView` against the owner's key from a source the server can't swap, with a
 * floor: the highest revision this device verified before (`TrustState.agentPolicyRevision`)
 * and any floor the caller adds (an agent's `agent_key` `policyRevision`). Every verified
 * revision (current, or an old one read on purpose) raises the device's floor and pins its hash
 * on the device (`TrustState.acceptAgentPolicy`): another owner-signed policy at a revision pinned with another
 * hash is a fork (the owner was led to sign over an older policy) and is refused as
 * `equivocation`, which callers treat like any policy that doesn't verify.
 *
 * Only the full policy is accepted unless the caller is an agent and opts in to its scoped view
 * (`view`): hidden hashes in a view verify against the owner's signature, since each override is
 * hashed on its own, so a server could otherwise hide an override from the owner, whose next
 * save would drop it.
 */

/** What checking an agent policy needs, all from sources the server can't swap. */
export interface AgentPolicyTrust {
  readonly workspaceId: string;
  /** The owner's Ed25519 public key: the account's own, or the one the CLI pinned. */
  readonly ownerSigningPublicKey: Uint8Array;
  readonly ownerAccountId: string;
  /**
   * Keeps the highest revision verified, the floor for later reads, and the hash verified at each
   * recent revision, refusing another one there (`equivocation`).
   */
  readonly trust?: TrustState;
  /** Every folder the caller sees: none of their overrides may hide among the hashes. */
  readonly visibleFolderIds?: Iterable<string>;
  /** An agent's token folders (empty: the whole workspace). */
  readonly scopeFolderIds?: readonly string[];
  /** A floor on top of the device's own (an agent's `agent_key` `policyRevision`). */
  readonly minRevision?: number;
  /**
   * The caller is an agent and accepts its scoped view. Without it (a person, the owner) only the
   * full policy is: any `otherFolderHashes` (`hidden_override`) or `ancestors`
   * (`unexpected_ancestors`) is refused, so the signed hash covers `default` and exactly the
   * overrides shown.
   */
  readonly view?: boolean;
}

/** A policy as the server sent it, with what checking it found. */
export interface CheckedAgentPolicy {
  readonly policy: AgentPolicy;
  readonly resolved: AgentPolicyViewResult;
}

/**
 * Checks a current policy (a full one; an agent's view only with `view`) against the owner's
 * signature, the floor and the hash pinned at its revision, and when it verifies pins its hash
 * and raises the device's floor to it. Any problem comes back in `resolved` (`ok: false`); the
 * caller treats every folder as `review` then.
 */
export function checkAgentPolicy(
  policy: AgentPolicy,
  options: AgentPolicyTrust,
): Promise<AgentPolicyViewResult> {
  return verifyAgentPolicy(policy, options, true);
}

/**
 * `checkAgentPolicy`, or with `current` false an old revision read on purpose: no floor (neither
 * the device's nor the caller's), but the hash pinned at that revision still applies, and a
 * verified one is pinned and raises the device's floor to it (an owner-signed revision proves the
 * current one is at least that, so this device never signs over a lower base).
 */
async function verifyAgentPolicy(
  policy: AgentPolicy,
  options: AgentPolicyTrust,
  current: boolean,
): Promise<AgentPolicyViewResult> {
  if (options.view !== true) {
    // a person's read: nothing hidden, no ancestors, so the hash is over exactly what is shown
    const hidden = policy.otherFolderHashes?.length ?? 0;
    if (hidden > 0) return { ok: false, problem: "hidden_override" };
    const ancestors = policy.ancestors?.length ?? 0;
    if (ancestors > 0) return { ok: false, problem: "unexpected_ancestors" };
  }
  const { trust, workspaceId } = options;
  const floor = current
    ? Math.max((await trust?.agentPolicyRevision(workspaceId)) ?? 0, options.minRevision ?? 0)
    : 0;
  const resolved = await resolveAgentPolicyView(policy, {
    workspaceId,
    ownerAccountId: options.ownerAccountId,
    visibleFolderIds: options.visibleFolderIds ?? [],
    ...(options.scopeFolderIds === undefined ? {} : { scopeFolderIds: options.scopeFolderIds }),
    minRevision: floor,
    verifySignature: agentPolicySignatureVerifier(
      options.ownerSigningPublicKey,
      options.ownerAccountId,
    ),
  });
  if (!resolved.ok || trust === undefined) return resolved;
  // one revision, one policy: another owner-signed hash where this device pinned one is a fork
  const pinned = await trust.acceptAgentPolicy(
    workspaceId,
    resolved.revision,
    resolved.policySha256,
  );
  return pinned ? resolved : { ok: false, problem: "equivocation" };
}

/**
 * Reads the workspace's agent policy (`getAgentPolicy`; an agent gets its view) and checks it
 * (`checkAgentPolicy`). With `revision`, reads that old revision instead: checked against the
 * owner's signature and the hash pinned at that revision (pinning it when none is), with no
 * floor; a verified one still raises the device's floor to it.
 */
export async function fetchAgentPolicy(
  api: ApiClient,
  options: AgentPolicyTrust & { readonly revision?: number },
): Promise<CheckedAgentPolicy> {
  const { data } = await api.call(routes.getAgentPolicy, {
    params: { workspaceId: options.workspaceId },
    query: options.revision === undefined ? {} : { revision: options.revision },
  });
  const { policy } = data;
  if (options.revision !== undefined) {
    if (policy.revision !== options.revision) {
      return { policy, resolved: { ok: false, problem: "malformed" } };
    }
    // an old revision: the owner's signature and the pin, no floor
    return { policy, resolved: await verifyAgentPolicy(policy, options, false) };
  }
  return { policy, resolved: await checkAgentPolicy(policy, options) };
}

/**
 * A checked policy that must verify: throws `rollback` below the floor, else `untrusted_signature`
 * (a fork at a pinned revision, `equivocation`, too).
 */
export function requireVerifiedPolicy(
  checked: CheckedAgentPolicy,
): Extract<AgentPolicyViewResult, { ok: true }> {
  const { resolved } = checked;
  if (resolved.ok) return resolved;
  throw resolved.problem === "below_floor"
    ? new VaultError("rollback", "the agent policy is older than one seen")
    : new VaultError("untrusted_signature", "the agent policy doesn't verify");
}

/**
 * The owner's `setAgentPolicy` request: the new rules, `baseRevision` (the revision the person
 * edited), and `agent_policy` signed over `baseRevision + 1` and the rules' hash.
 */
export async function prepareAgentPolicy(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly default: AgentWriteMode;
    readonly folders: readonly AgentPolicyFolder[];
    readonly baseRevision: number;
  } & SigningTime,
): Promise<SetAgentPolicyRequest> {
  const folders = [...details.folders];
  const action = signAgentPolicy(signer, {
    workspaceId: details.workspaceId,
    revision: details.baseRevision + 1,
    policySha256: await agentPolicySha256({ default: details.default, folders }),
    ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
  });
  return {
    default: details.default,
    folders,
    baseRevision: details.baseRevision,
    signedAt: action.signedAt,
    signature: action.signature,
  };
}

/** The agent-key fields of an `approveConnect` request, from `prepareAgentKeyApproval`. */
export interface AgentKeyApproval {
  /** Exactly the request's agent-key fields: spread them into the strict request body. */
  readonly fields: {
    readonly signPublicKey: string;
    readonly agentKeySignedAt: string;
    readonly agentKeySignature: string;
  };
  /** The policy revision signed in as the agent's floor (the server rebuilds it with its own). */
  readonly policyRevision: number;
}

/**
 * The agent-key fields of an `approveConnect` request (session, the workspace owner), for a CLI
 * whose connect fragment carried `signPublicKey`: reads the current agent policy, checks it with
 * the owner's own key as the full policy (never an agent's view), with the device's floor
 * (raising it), its pinned hashes (a fork is `untrusted_signature`) and the highest revision
 * signed into the workspace's agent keys (`listKeys`), then signs `agent_key` naming the token,
 * the agent's key and that revision. Send `fields` only
 * when the fragment had the key. The server rebuilds `agent_key` with its current revision: when
 * the policy moved since, it answers 409 `stale_agent_policy` (prepare again and approve again),
 * and 400 `invalid_signature` for any other mismatch.
 */
export async function prepareAgentKeyApproval(
  api: ApiClient,
  details: {
    readonly signer: Signer;
    readonly workspaceId: string;
    readonly tokenId: string;
    /** The agent's Ed25519 public key from the fragment (bytes, or base64url). */
    readonly signPublicKey: Uint8Array | string;
    readonly trust?: TrustState;
    /** The workspace's folders the caller knows, none of whose overrides may hide. */
    readonly visibleFolderIds?: Iterable<string>;
  } & SigningTime,
): Promise<AgentKeyApproval> {
  const { signer } = details;
  const signPublicKey =
    typeof details.signPublicKey === "string"
      ? fromBase64Url(details.signPublicKey)
      : details.signPublicKey;
  if (signPublicKey.length !== 32) {
    throw new VaultError("untrusted_signature", "the agent's signing key isn't an Ed25519 key");
  }
  const { data: listed } = await api.call(routes.listKeys);
  const vouched = verifiedAgentKeys(
    listed,
    { publicKey: signer.signing.publicKey, accountId: signer.accountId },
    details.workspaceId,
  );
  const checked = await fetchAgentPolicy(api, {
    workspaceId: details.workspaceId,
    ownerSigningPublicKey: signer.signing.publicKey,
    ownerAccountId: signer.accountId,
    ...(details.trust === undefined ? {} : { trust: details.trust }),
    ...(details.visibleFolderIds === undefined
      ? {}
      : { visibleFolderIds: details.visibleFolderIds }),
    // the owner signed each agent_key over a revision it verified: none can be newer than the policy
    minRevision: Math.max(0, ...[...vouched.values()].flat().map((key) => key.policyRevision)),
  });
  const { revision } = requireVerifiedPolicy(checked);
  const action = signAgentKey(signer, {
    workspaceId: details.workspaceId,
    tokenId: details.tokenId,
    signPublicKey,
    policyRevision: revision,
    ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
  });
  return {
    fields: {
      signPublicKey: toBase64Url(signPublicKey),
      agentKeySignedAt: action.signedAt,
      agentKeySignature: action.signature,
    },
    policyRevision: revision,
  };
}
