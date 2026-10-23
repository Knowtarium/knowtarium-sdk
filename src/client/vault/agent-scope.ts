import { verifyEnvelopeFor } from "../../crypto/index.js";
import {
  type AgentPermission,
  type AgentScopeBody,
  agentScopeSha256,
  type AgentToken,
  NO_PREVIOUS_AGENT_SCOPE_SHA256,
  routes,
  type SignedAgentScope,
  SignedAgentScope as SignedAgentScopeSchema,
  sortAgentPermissions,
  type TokenAccess,
  type TokenId,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { isSyncApiError, VaultError } from "../errors/index.js";
import {
  type AgentScopeRoute,
  signAgentScope,
  type SignedAction,
  signingFields,
} from "./envelopes.js";
import type { Signer } from "./signer.js";
import type { TrustState } from "./trust.js";
import { toSignedEnvelope } from "./verify.js";

/*
 * Agent scopes (protocol 3): the owner signs every scope it gives an agent token (`agent_scope`:
 * the token, the revision and `agentScopeSha256` of its access, folders and permissions), at
 * connect (revision 1) and on every change (`updateTokenScope`). The CLI verifies its own token's
 * scope under the owner key it pinned at connect and keeps the highest revision it verified as a
 * floor; the web app verifies each token's scope under the person's own key and keeps a floor per
 * token on the device (`TrustState.acceptAgentScopeRevision`), and reads every revision to audit
 * an agent's actions against the scope it acted under (`fetchTokenScopes`).
 */

/** A scope as the owner chose it: access, folders (empty: the whole workspace), permissions. */
export interface AgentScopeChoice {
  readonly access: TokenAccess;
  readonly folderIds: readonly string[];
  readonly permissions: readonly AgentPermission[];
}

/** A signed scope that verified, with what it says. */
export interface VerifiedAgentScope {
  readonly revision: number;
  /** The scope, with `permissions` in `AgentPermission` order. */
  readonly scope: AgentScopeBody;
  readonly scopeSha256: string;
  /** The revision before's `scopeSha256` (`NO_PREVIOUS_AGENT_SCOPE_SHA256` at revision 1). */
  readonly prevScopeSha256: string;
  /** When the owner signed it (the envelope's `createdAt`). */
  readonly signedAt: string;
  readonly signed: SignedAgentScope;
}

/** Why `verifyAgentScope` refused a token's scope. */
export type AgentScopeProblem =
  /** The record doesn't parse. */
  | "malformed"
  /** Signed for another token. */
  | "wrong_token"
  /** Signed for another workspace. */
  | "wrong_workspace"
  /** Signed by another account than the workspace owner's. */
  | "wrong_account"
  /** The signed hash isn't the hash of the scope that came with it. */
  | "hash_mismatch"
  /** The owner's signature doesn't verify. */
  | "bad_signature"
  /** A revision below the floor, or none after one was seen. */
  | "rollback"
  /**
   * Another owner-signed scope than the one the caller kept at that revision, or one that doesn't
   * continue it (`prevScopeSha256`), or a revision 1 that claims a previous one.
   */
  | "fork";

export type AgentScopeVerification =
  | {
      readonly ok: true;
      /** 0 for a token whose scope was never signed: no permissions, the access stored at connect. */
      readonly revision: number;
      /** Null at revision 0. */
      readonly verified: VerifiedAgentScope | null;
    }
  | { readonly ok: false; readonly problem: AgentScopeProblem };

/** Whom a token's scope must come from, and the lowest revision accepted. */
export interface AgentScopeTrust {
  /** The owner's signing key, from a source the server can't swap. */
  readonly ownerSigningPublicKey: Uint8Array;
  /** The workspace owner's account ID. */
  readonly accountId: string;
  readonly workspaceId: string;
  readonly tokenId: string;
  /**
   * The highest revision the caller verified before (the CLI's `agent-scopes.enc`, a device's
   * mark); 0 when none. A lower revision, or no signed scope at all after one, is `rollback`.
   */
  readonly minRevision?: number;
  /**
   * The `scopeSha256` of the scope verified at `minRevision`, when the caller kept it: a scope at
   * that revision must be the same one, and one at the next revision must chain to it
   * (`prevScopeSha256`), else `fork`.
   */
  readonly floorScopeSha256?: string;
}

/**
 * Checks a token's signed scope (`AgentToken.scope`, or one entry of `listTokenScopes`): the
 * owner's signature under the trusted key, the token, workspace and account it names, the hash
 * against the scope it carries, the chain (revision 1 has no previous scope; with
 * `floorScopeSha256`, the same scope at the floor's revision and one chained to it at the next),
 * and the revision against the floor. A missing scope (revision 0) passes only while the floor is
 * 0.
 */
export async function verifyAgentScope(
  signed: SignedAgentScope | null | undefined,
  trust: AgentScopeTrust,
): Promise<AgentScopeVerification> {
  const floor = trust.minRevision ?? 0;
  if (!Number.isSafeInteger(floor) || floor < 0) {
    throw new TypeError("verifyAgentScope: minRevision must be a safe integer of 0 or more");
  }
  const refuse = (problem: AgentScopeProblem) => ({ ok: false, problem }) as const;
  if (signed == null) {
    return floor > 0 ? refuse("rollback") : { ok: true, revision: 0, verified: null };
  }
  const parsed = SignedAgentScopeSchema.safeParse(signed);
  if (!parsed.success) return refuse("malformed");
  const { envelope, scope } = parsed.data;
  if (envelope.tokenId !== trust.tokenId) return refuse("wrong_token");
  if (envelope.workspaceId !== trust.workspaceId) return refuse("wrong_workspace");
  if (envelope.accountId !== trust.accountId) return refuse("wrong_account");
  let hash: string;
  try {
    hash = await agentScopeSha256(scope);
  } catch (error) {
    if (error instanceof TypeError) return refuse("malformed");
    throw error;
  }
  if (hash !== envelope.scopeSha256) return refuse("hash_mismatch");
  const ok = verifyEnvelopeFor(toSignedEnvelope(parsed.data), trust.ownerSigningPublicKey, {
    type: "agent_scope",
    accountId: trust.accountId,
    workspaceId: trust.workspaceId,
    tokenId: trust.tokenId,
  });
  if (!ok) return refuse("bad_signature");
  if (envelope.revision < floor) return refuse("rollback");
  // the chain: revision 1 starts it; next to a scope this caller kept, it must continue it
  if (envelope.revision === 1 && envelope.prevScopeSha256 !== NO_PREVIOUS_AGENT_SCOPE_SHA256) {
    return refuse("fork");
  }
  const kept = trust.floorScopeSha256;
  if (kept !== undefined && floor > 0) {
    if (envelope.revision === floor && hash !== kept) return refuse("fork");
    if (envelope.revision === floor + 1 && envelope.prevScopeSha256 !== kept) {
      return refuse("fork");
    }
  }
  return {
    ok: true,
    revision: envelope.revision,
    verified: {
      revision: envelope.revision,
      scope: { ...scope, permissions: sortAgentPermissions(scope.permissions) },
      scopeSha256: hash,
      prevScopeSha256: envelope.prevScopeSha256,
      signedAt: envelope.createdAt,
      signed: parsed.data,
    },
  };
}

/**
 * The owner signs a token's scope at `revision` (1 at connect, then `baseRevision + 1`): the
 * `agent_scope` over `agentScopeSha256` of `scope`, chained to the revision before
 * (`prevScopeSha256`; `NO_PREVIOUS_AGENT_SCOPE_SHA256` at revision 1, the default). Returns the
 * signed action and the hash.
 */
export async function signAgentScopeRevision(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly tokenId: string;
    readonly revision: number;
    readonly scope: AgentScopeChoice;
    readonly prevScopeSha256?: string;
    readonly route?: AgentScopeRoute;
    readonly signedAt?: string;
  },
): Promise<SignedAction & { readonly scopeSha256: string }> {
  const scopeSha256 = await agentScopeSha256(details.scope);
  const action = signAgentScope(signer, {
    workspaceId: details.workspaceId,
    tokenId: details.tokenId,
    revision: details.revision,
    scopeSha256,
    prevScopeSha256: details.prevScopeSha256 ?? NO_PREVIOUS_AGENT_SCOPE_SHA256,
    ...(details.route === undefined ? {} : { route: details.route }),
    ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
  });
  return { ...action, scopeSha256 };
}

/**
 * The protocol 3 fields of an `approveConnect` body: the permissions chosen and the owner's
 * `agent_scope` at revision 1 over the access, folders and permissions (send them with the rest
 * of the approval). Permissions need `read-write`: with `read` they are dropped.
 */
export async function prepareConnectScope(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly tokenId: string;
    readonly signedAt?: string;
  } & AgentScopeChoice,
): Promise<{
  readonly permissions: AgentPermission[];
  readonly scopeSignedAt: string;
  readonly scopeSignature: string;
}> {
  const permissions =
    details.access === "read-write" ? sortAgentPermissions(details.permissions) : [];
  const action = await signAgentScopeRevision(signer, {
    workspaceId: details.workspaceId,
    tokenId: details.tokenId,
    revision: 1,
    scope: { access: details.access, folderIds: details.folderIds, permissions },
    route: "approveConnect",
    ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
  });
  return { permissions, scopeSignedAt: action.signedAt, scopeSignature: action.signature };
}

/** What `updateTokenScope` did. */
export type UpdateTokenScopeResult =
  | {
      readonly status: "saved";
      readonly token: AgentToken;
      readonly verified: VerifiedAgentScope;
    }
  | {
      /** The token's scope changed since `baseRevision`: read the token again and sign anew. */
      readonly status: "conflict";
      readonly currentRevision: number;
    }
  | {
      /**
       * `baseRevision` is below a revision this device already verified (`floorRevision`):
       * nothing was signed or sent, since signing over it would fork that revision. Read the
       * token again.
       */
      readonly status: "stale";
      readonly floorRevision: number;
    };

/**
 * The owner changes a token's access, folders and permissions together (session), signing the
 * next scope revision (`baseRevision + 1`), chained to the scope at `baseRevision`, which it
 * reads and verifies first (`fetchTokenScopes`: a newer revision there answers `conflict`, a list
 * that doesn't verify whole throws `untrusted_signature`). The server keeps each revision's hash,
 * so sending the same change again after a lost answer (or a save that stopped halfway) succeeds
 * rather than conflicting. The answer must hold that revision with this hash, signed by the
 * owner, else `untrusted_signature`; the revision then becomes this device's floor for the token
 * (`trust`). A `baseRevision` below that floor answers `stale` without signing anything.
 */
export async function updateTokenScope(
  api: ApiClient,
  flow: { readonly signer: Signer; readonly trust?: TrustState },
  change: {
    readonly workspaceId: string;
    readonly tokenId: TokenId;
    readonly baseRevision: number;
    readonly signedAt?: string;
  } & AgentScopeChoice,
): Promise<UpdateTokenScopeResult> {
  const { signer } = flow;
  const permissions =
    change.access === "read-write" ? sortAgentPermissions(change.permissions) : [];
  const scope = { access: change.access, folderIds: [...change.folderIds], permissions };
  // an edit of a revision older than one this device verified: signing it would fork the next
  const seen = (await flow.trust?.agentScopeRevision(change.tokenId)) ?? 0;
  if (change.baseRevision < seen) return { status: "stale", floorRevision: seen };
  const owner = {
    ownerSigningPublicKey: signer.signing.publicKey,
    accountId: signer.accountId,
    workspaceId: change.workspaceId,
    tokenId: change.tokenId,
  };
  // the scope the new revision continues, read and verified (none before revision 1)
  let prevScopeSha256 = NO_PREVIOUS_AGENT_SCOPE_SHA256;
  if (change.baseRevision > 0) {
    const listed = await fetchTokenScopes(api, {
      ...owner,
      ...(flow.trust === undefined ? {} : { trust: flow.trust }),
    });
    const newest = listed.scopes.at(-1)?.revision ?? 0;
    if (listed.problem === null && newest > change.baseRevision) {
      return { status: "conflict", currentRevision: newest };
    }
    const base = listed.scopes.find((each) => each.revision === change.baseRevision);
    if (listed.problem !== null || base === undefined) {
      throw new VaultError("untrusted_signature", "the agent's scope revisions don't verify");
    }
    prevScopeSha256 = base.scopeSha256;
  }
  const revision = change.baseRevision + 1;
  const action = await signAgentScopeRevision(signer, {
    workspaceId: change.workspaceId,
    tokenId: change.tokenId,
    revision,
    scope,
    prevScopeSha256,
    ...(change.signedAt === undefined ? {} : { signedAt: change.signedAt }),
  });
  let token: AgentToken;
  try {
    ({
      data: { token },
    } = await api.call(routes.updateTokenScope, {
      params: { tokenId: change.tokenId },
      body: {
        baseRevision: change.baseRevision,
        access: change.access,
        folderIds: [...new Set(change.folderIds)] as AgentToken["folderIds"],
        permissions,
        ...signingFields(action),
      },
    }));
  } catch (error) {
    if (!isSyncApiError(error, "scope_conflict")) throw error;
    const { detail } = error;
    return {
      status: "conflict",
      currentRevision:
        detail.code === "scope_conflict" ? detail.currentRevision : change.baseRevision,
    };
  }
  // exactly this revision with this hash, chained to the base, signed by the owner (an earlier
  // attempt's signature of the same scope counts: the hash covers the scope, not the time)
  const result = await verifyAgentScope(token.scope, {
    ...owner,
    minRevision: change.baseRevision,
    ...(change.baseRevision > 0 ? { floorScopeSha256: prevScopeSha256 } : {}),
  });
  if (
    !result.ok ||
    result.verified === null ||
    result.revision !== revision ||
    result.verified.scopeSha256 !== action.scopeSha256 ||
    result.verified.prevScopeSha256 !== prevScopeSha256 ||
    token.scopeRevision !== revision
  ) {
    throw new VaultError("untrusted_signature", "the server stored another agent scope");
  }
  await flow.trust?.acceptAgentScopeRevision(change.tokenId, revision, action.scopeSha256);
  return { status: "saved", token, verified: result.verified };
}

/** Every signed scope revision of a token, verified, and what doesn't add up. */
export interface TokenScopes {
  /** The revisions that verified, oldest first. */
  readonly scopes: readonly VerifiedAgentScope[];
  /**
   * Null when the list is whole: every revision from 1 to the newest, each chained to the one
   * before, none below the device's floor. Otherwise why it can't be trusted whole: `gap` (a
   * revision missing, or one that didn't verify), `fork` (two scopes at one revision, a broken
   * chain, or another scope than this device verified at its floor), `below_floor` (the newest
   * is below a revision this device saw).
   */
  readonly problem: "gap" | "fork" | "below_floor" | null;
}

/**
 * A token's signed scope revisions (`listTokenScopes`; the owner's session, or the agent itself),
 * each verified under the owner's key and chained to the one before. A revision that doesn't
 * verify is left out and reads as a gap; two at one revision or a broken chain is a `fork`; a
 * list stopping below the device's floor (`trust`) is `below_floor`. A whole list raises the
 * floor to its newest revision (with its hash).
 */
export async function fetchTokenScopes(
  api: ApiClient,
  details: Omit<AgentScopeTrust, "minRevision" | "floorScopeSha256"> & {
    readonly trust?: TrustState;
  },
): Promise<TokenScopes> {
  const { data } = await api.call(routes.listTokenScopes, {
    params: { tokenId: details.tokenId },
  });
  const { trust, ...owner } = details;
  const scopes: VerifiedAgentScope[] = [];
  for (const signed of data.scopes) {
    const result = await verifyAgentScope(signed, owner);
    if (result.ok && result.verified !== null) scopes.push(result.verified);
  }
  scopes.sort((a, b) => a.revision - b.revision);
  const floor = (await trust?.agentScopeRevision(details.tokenId)) ?? 0;
  const pinned = await trust?.agentScopeSha256(details.tokenId);
  const twice = scopes.some((scope, index) => scopes[index - 1]?.revision === scope.revision);
  const chained = scopes.every(
    (scope, index) =>
      scope.prevScopeSha256 ===
      (index === 0 ? NO_PREVIOUS_AGENT_SCOPE_SHA256 : scopes[index - 1]?.scopeSha256),
  );
  const atFloor = scopes.find((scope) => scope.revision === floor);
  if (twice || (pinned !== undefined && atFloor !== undefined && atFloor.scopeSha256 !== pinned)) {
    return { scopes, problem: "fork" };
  }
  const newest = scopes.at(-1)?.revision ?? 0;
  if (newest < floor) return { scopes, problem: "below_floor" };
  const whole =
    scopes.length === data.scopes.length &&
    scopes.every((scope, index) => scope.revision === index + 1);
  if (!whole) return { scopes, problem: "gap" };
  if (!chained) return { scopes, problem: "fork" };
  const last = scopes.at(-1);
  if (last !== undefined) {
    await trust?.acceptAgentScopeRevision(details.tokenId, last.revision, last.scopeSha256);
  }
  return { scopes, problem: null };
}
