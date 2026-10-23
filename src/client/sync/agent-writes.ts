import { normalizeNoteName, ROOT_FOLDER_NAME } from "../../core/files/index.js";
import { fromBase64Url, toBase64Url } from "../../crypto/index.js";
import {
  type AgentEditedEnvelope,
  type AgentPermission,
  type AgentScopeBody,
  agentScopeAllows,
  type Folder,
  type FolderId,
  type AgentPolicyFolder,
  type AgentPolicyFolderLookup,
  type AgentPolicyRules,
  agentPolicyAncestry,
  type AgentWriteMode,
  effectiveMode,
  formatVersionTag,
  MISSING_AGENT_POLICY_SHA256,
  type NoteId,
  SIGNATURE_MAX_SKEW_SECONDS,
  routes,
} from "../../protocol/index.js";
import { isSyncApiError, RequestValidationError, VaultError } from "../errors/index.js";
import { newId, newPendingNonce } from "../platform/ids.js";
import {
  type AgentActionRevisions,
  type AgentPolicyTrust,
  type AgentSigner,
  type CheckedAgentPolicy,
  checkAgentPolicy,
  decryptFolderName,
  encryptEvent,
  encryptFolderName,
  encryptNote,
  fetchAgentPolicy,
  prepareAgentPolicy,
  signAgentDeleted,
  signAgentEdited,
  signAgentFolderCreated,
  signAgentFolderDeleted,
  signAgentFolderMoved,
  signAgentFolderRenamed,
  signingFields,
  signingHeaders,
  type TokenScopes,
  type VerifiedAgentKey,
} from "../vault/index.js";
import { eventSignatureValid } from "../history/verify.js";
import {
  type AgentConnection,
  requireAgent,
  requireIdentity,
  type SyncContext,
  withCurrentKey,
  withKeys,
} from "./context.js";
import { fetchFolderEvents, type FolderEventEntry } from "./folder-events.js";
import { acceptNote, checkStoredWrite, fetchEvents } from "./notes.js";
import type {
  AgentAction,
  AgentActionAudit,
  AgentActionRefusal,
  AgentFolderResult,
  AgentWriteAudit,
  AgentWriteConflict,
  AgentWriteResult,
  SetAgentPolicyResult,
  SubmitResult,
} from "./results.js";
import { type ConflictHandling, conflictResult, type NoteWrite } from "./writes.js";

/*
 * Protocol 2 on the engine: an agent writing directly (`writeAsAgent`), the owner reading and
 * setting the agent policy, and a second look at an agent's version against the policy revision
 * it named (`auditAgentVersion`). The server enforces the policy; the agent checks it too before
 * writing, against the owner's signature and its floor, so a server can't silently turn a folder
 * to direct for it. Any doubt reads as `review`, and the CLI proposes instead.
 */

/** An agent's direct write of a note. */
export interface AgentNoteWrite extends Omit<NoteWrite, "checkId"> {
  /**
   * The highest agent policy revision the caller pinned (the CLI's credentials), on top of the
   * `agent_key` floor and the device's own mark: no lower revision is accepted.
   */
  readonly minPolicyRevision?: number;
  /**
   * Looks a folder up for the policy's ancestry (the folder, its parent and so on); defaults to
   * the folders the engine has seen. Above the agent's scope it knows nothing, which the view's
   * `ancestors` cover.
   */
  readonly folders?: AgentPolicyFolderLookup;
  /**
   * More folders the caller sees, none of whose overrides may hide among the policy's hashes:
   * added to the engine's folders and every folder `folders` puts on the way up from the
   * destination (and from the note's current folder, for a move), which are always checked.
   */
  readonly visibleFolderIds?: Iterable<string>;
  /**
   * Appends the agent's unsigned `wrote` record after the write (who, and a summary). Best
   * effort: the version stands either way (`recorded` says whether it was stored).
   */
  readonly record?: { readonly actor: string; readonly summary?: string };
}

const sameKey = (a: Uint8Array, b: Uint8Array) => toBase64Url(a) === toBase64Url(b);

/** The engine's folders as a lookup for `agentPolicyAncestry`. */
function knownFolders(context: SyncContext): AgentPolicyFolderLookup {
  return (folderId) => context.folders.get(folderId);
}

/** Whether this engine reads as a person (a session), who gets the full policy, not a view. */
function readsAsPerson(context: SyncContext): boolean {
  return context.api.auth.kind !== "agent";
}

/**
 * What checking the policy needs on this engine: the owner, the device's floor, the folders. Only
 * an agent's engine accepts its scoped view (`view`); a person's accepts only the full policy, as
 * an owner's engine may have no folders synced, so a view hiding an override would pass
 * `visibleFolderIds` alone.
 */
function policyTrust(
  context: SyncContext,
  minRevision?: number,
  visibleFolderIds: Iterable<string> = context.folders.keys(),
): AgentPolicyTrust {
  const { owner } = context.verifier;
  if (owner.accountId === undefined) throw new RequestValidationError("getAgentPolicy", "auth");
  const scope = context.agent?.folderIds;
  return {
    workspaceId: context.workspaceId,
    ownerSigningPublicKey: owner.publicKey,
    ownerAccountId: owner.accountId,
    trust: context.trust,
    visibleFolderIds,
    ...(scope === undefined ? {} : { scopeFolderIds: scope }),
    ...(minRevision === undefined ? {} : { minRevision }),
    ...(readsAsPerson(context) ? {} : { view: true }),
  };
}

/** The engine's folders plus any more the caller knows. */
function visibleFolders(context: SyncContext, more: Iterable<string> = []): Set<string> {
  return new Set([...context.folders.keys(), ...more]);
}

/** This agent's own key as the owner vouched for it (empty: none, or another key). */
async function ownKeys(context: SyncContext, agent: AgentConnection): Promise<VerifiedAgentKey[]> {
  const keys = await context.verifier.agentKeys.forToken(agent.tokenId);
  return keys.filter((key) => sameKey(key.publicKey, agent.signing.publicKey));
}

/** What a policy read takes: a floor of the caller's, an old revision, more visible folders. */
export interface AgentPolicyRead {
  readonly minRevision?: number;
  readonly revision?: number;
  /** More folders the caller sees (the workspace's tree), on top of the engine's own. */
  readonly visibleFolderIds?: Iterable<string>;
}

/**
 * The agent policy, read and checked (the owner's signature, the floor, hidden overrides). For an
 * agent the floor includes its `agent_key`'s `policyRevision`; for a person, the highest
 * `policyRevision` of every agent key the owner vouched for in the workspace (revoked ones too),
 * and only the full policy is accepted, never a view. A verified revision raises this device's
 * mark and pins its hash. An old revision (`revision`) is checked against the signature and the
 * pinned hash only, with no floor.
 */
export async function readAgentPolicy(
  context: SyncContext,
  options: AgentPolicyRead = {},
): Promise<CheckedAgentPolicy> {
  let floor = options.minRevision ?? 0;
  // an old revision is checked against the signature only: no floor to look up
  if (options.revision === undefined) {
    let keys: readonly VerifiedAgentKey[] = [];
    if (readsAsPerson(context)) keys = await context.verifier.agentKeys.all();
    else if (context.agent !== undefined) keys = await ownKeys(context, context.agent);
    floor = Math.max(floor, ...keys.map((key) => key.policyRevision));
  }
  return fetchAgentPolicy(context.api, {
    ...policyTrust(context, floor, visibleFolders(context, options.visibleFolderIds)),
    ...(options.revision === undefined ? {} : { revision: options.revision }),
  });
}

/**
 * The owner replaces the agent policy (session): `default` and the folder overrides, on top of
 * `baseRevision` (the revision the person edited), signed as `agent_policy`. When the policy
 * changed meanwhile, returns the current one (checked) instead, to edit again: also, without
 * signing anything, for a base below a revision this device already verified, since signing over
 * it would fork that revision. A saved policy pins the hash signed at its revision on this device.
 */
export async function setAgentPolicy(
  context: SyncContext,
  change: {
    readonly default: AgentWriteMode;
    readonly folders: readonly AgentPolicyFolder[];
    readonly baseRevision: number;
    readonly signedAt?: string;
    /** More folders the caller sees, for checking the stored and the current policy. */
    readonly visibleFolderIds?: Iterable<string>;
  },
): Promise<SetAgentPolicyResult> {
  const identity = requireIdentity(context, "setAgentPolicy");
  const { visibleFolderIds, ...rules } = change;
  const visible = visibleFolders(context, visibleFolderIds);
  const conflict = async (currentVersion?: number): Promise<SetAgentPolicyResult> => {
    const current = await readAgentPolicy(context, { visibleFolderIds: visible });
    return {
      status: "conflict",
      currentRevision: currentVersion ?? current.policy.revision,
      current,
    };
  };
  // an edit of a revision older than one this device verified: signing it would fork the next one
  if (change.baseRevision < (await context.trust.highestAgentPolicyRevision(context.workspaceId))) {
    return conflict();
  }
  const body = await prepareAgentPolicy(identity, {
    workspaceId: context.workspaceId,
    ...rules,
  });
  try {
    const { data } = await context.api.call(routes.setAgentPolicy, {
      params: { workspaceId: context.workspaceId },
      body,
    });
    const stored = data.policy;
    // the server must store exactly what was signed, as the next revision; only then is its hash
    // (the one signed) pinned, and refused if this device pinned another at that revision
    if (
      stored.revision !== change.baseRevision + 1 ||
      stored.signed?.signature !== body.signature
    ) {
      throw new VaultError("untrusted_signature", "the server stored another agent policy");
    }
    const resolved = await checkAgentPolicy(stored, policyTrust(context, undefined, visible));
    if (!resolved.ok) {
      throw new VaultError("untrusted_signature", "the server stored another agent policy");
    }
    return {
      status: "saved",
      policy: stored,
      revision: stored.revision,
      workspaceVersion: data.workspaceVersion,
    };
  } catch (error) {
    if (!isSyncApiError(error, "conflict")) throw error;
    return conflict(error.currentVersion);
  }
}

/**
 * An agent writes a note version directly, signed with its own key (`agent_edited`). First it
 * checks its key is the one the owner vouched for, reads the policy and checks it (the owner's
 * signature; the floor: the `agent_key`'s `policyRevision`, the device's mark and
 * `minPolicyRevision`) and the folder's mode; anything but `direct` returns `approval_required`
 * without sending, and so does the server's own refusal. A `stale_agent_policy` answer (the
 * policy changed meanwhile) reads the policy again and tries once more. A 409 returns both
 * versions, with `currentVersion`.
 */
export async function writeAsAgent(
  context: SyncContext,
  write: AgentNoteWrite,
  handling: ConflictHandling = {},
): Promise<AgentWriteResult> {
  // an engine with no signing key of its own can only propose
  if (context.agent === undefined) return { status: "agent_key_required" };
  const { agent, signer } = requireAgent(context, "writeNoteAsAgent");
  const { workspaceId } = context;
  const own = await ownKeys(context, agent);
  if (own.length === 0) return { status: "agent_key_required" };
  const floor = Math.max(write.minPolicyRevision ?? 0, ...own.map((key) => key.policyRevision));
  const lookup = write.folders ?? knownFolders(context);
  // a move: the folder the note leaves must be direct too (the server checks it as well)
  const from = context.noteFolders.get(write.noteId);
  const touched =
    from === undefined || from === write.folderId ? [write.folderId] : [from, write.folderId];
  if (touched.some((folderId) => lookup(folderId) === undefined)) {
    return { status: "approval_required", reason: "unknown_folder", policyRevision: null };
  }
  const ancestries = touched.map((folderId) => agentPolicyAncestry(folderId, lookup));
  // built once, so the retry after stale_agent_policy checks the same set
  const visible = new Set([
    ...(write.visibleFolderIds ?? []),
    ...context.folders.keys(),
    ...ancestries.flatMap((ancestry) =>
      ancestry.filter((folder) => folder.unknown !== true).map((folder) => folder.folderId),
    ),
  ]);
  let lastRevision: number | null = null;

  const attempt = async (retried: boolean): Promise<AgentWriteResult> => {
    const { resolved } = await fetchAgentPolicy(context.api, policyTrust(context, floor, visible));
    if (!resolved.ok) {
      return {
        status: "approval_required",
        reason: "unverified_policy",
        policyRevision: null,
        problem: resolved.problem,
      };
    }
    lastRevision = resolved.revision;
    if (ancestries.some((ancestry) => effectiveMode(resolved.rules, ancestry) !== "direct")) {
      return { status: "approval_required", reason: "policy", policyRevision: resolved.revision };
    }
    try {
      return await withCurrentKey(context, async (keys) => {
        const ciphertext = encryptNote(
          keys.current,
          { workspaceId, noteId: write.noteId },
          { name: write.name, text: write.text },
        );
        const action = signAgentEdited(signer, {
          workspaceId,
          noteId: write.noteId,
          folderId: write.folderId,
          baseVersion: write.baseVersion,
          ciphertext,
          revision: resolved.revision,
          // at revision 0 (no policy yet) the resolver returns MISSING_AGENT_POLICY_SHA256
          policySha256: resolved.policySha256,
          ...(write.signedAt === undefined ? {} : { signedAt: write.signedAt }),
        });
        const { data } = await context.api.call(routes.writeNoteAsAgent, {
          params: { workspaceId, noteId: write.noteId },
          headers: {
            "if-match": formatVersionTag(write.baseVersion),
            "knowtarium-folder-id": write.folderId,
            ...signingHeaders(action),
            "knowtarium-agent-policy-revision": String(resolved.revision),
          },
          body: ciphertext,
        });
        checkStoredWrite(context, data, { ...write, ciphertext }, own);
        const note = await acceptNote(context, {
          noteId: write.noteId,
          folderId: data.note.folderId,
          version: data.note.currentVersion,
          name: normalizeNoteName(write.name),
          text: write.text,
          createdAt: data.note.createdAt,
          ciphertext,
          event: data.event,
          agentKeys: own,
        });
        return {
          status: "saved" as const,
          note,
          workspaceVersion: data.workspaceVersion,
          policyRevision: resolved.revision,
          recorded: false,
        };
      });
    } catch (error) {
      if (isSyncApiError(error, "stale_agent_policy") && !retried) return attempt(true);
      throw error;
    }
  };

  let result: AgentWriteResult;
  try {
    result = await attempt(false);
  } catch (error) {
    if (isSyncApiError(error, "approval_required")) {
      return { status: "approval_required", reason: "server", policyRevision: lastRevision };
    }
    if (isSyncApiError(error, "agent_key_required")) return { status: "agent_key_required" };
    if (isSyncApiError(error, "rate_limited")) {
      const { detail } = error;
      return {
        status: "rate_limited",
        retryAfterSeconds: detail.code === "rate_limited" ? detail.retryAfterSeconds : null,
      };
    }
    if (!isSyncApiError(error, "conflict") || handling.readConflict === false) throw error;
    const conflict = await conflictResult(context, write.noteId, {
      baseVersion: write.baseVersion,
      name: write.name,
      text: write.text,
    });
    return { ...conflict, currentVersion: conflict.theirs.version } satisfies AgentWriteConflict;
  }
  if (result.status !== "saved" || write.record === undefined) return result;
  return { ...result, recorded: await recordWrote(context, result.note.noteId, result, write) };
}

/** Appends the agent's unsigned `wrote` record for its new version; false when it fails. */
async function recordWrote(
  context: SyncContext,
  noteId: NoteId,
  saved: { readonly note: { readonly version: number } },
  write: Pick<AgentNoteWrite, "record">,
): Promise<boolean> {
  const record = write.record;
  if (record === undefined) return false;
  const { workspaceId } = context;
  try {
    await withCurrentKey(context, async (keys) => {
      const id = newId("evt");
      const sealed = encryptEvent(
        keys.current,
        { workspaceId, id },
        {
          type: "wrote",
          actor: record.actor,
          at: new Date().toISOString(),
          version: saved.note.version,
          ...(record.summary === undefined ? {} : { summary: record.summary }),
        },
      );
      await context.api.call(routes.addEvent, {
        params: { workspaceId },
        body: { id, noteId, noteVersion: saved.note.version, ciphertext: sealed.ciphertext },
        idempotent: true,
      });
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Looks again at an agent's version (`agent_edited`, verified under its vouched key) against the
 * policy revision it named: the owner-signed hash of that revision must be the one the agent
 * signed, and, with folders known (`folders`, defaulting to the engine's), the folder's mode
 * under it. The server enforces the policy when the agent writes, so this is an audit for display,
 * never a reason to refuse the version. Throws `untrusted_signature` when the version has no
 * valid agent signature.
 */
export async function auditAgentVersion(
  context: SyncContext,
  noteId: NoteId,
  version: number,
  options: {
    readonly folders?: AgentPolicyFolderLookup;
    /** More folders the caller sees, for checking that revision. */
    readonly visibleFolderIds?: Iterable<string>;
  } = {},
): Promise<AgentWriteAudit> {
  const { workspaceId } = context;
  const events = await fetchEvents(context, { noteId });
  let fields: AgentEditedEnvelope | undefined;
  for (const event of events) {
    const signed = event.signed;
    if (signed?.envelope.type !== "agent_edited" || event.noteVersion !== version) continue;
    const keys = await context.verifier.agentKeys.forToken(signed.envelope.tokenId);
    if (eventSignatureValid(event, workspaceId, context.verifier.owner, keys)) {
      fields = signed.envelope;
      break;
    }
  }
  if (fields === undefined) {
    throw new VaultError("untrusted_signature", "no valid agent signature for this version");
  }
  const { revision, policySha256, folderId } = fields;
  // a hash other than the one this device pinned at that revision: the agent was shown a fork
  const pinned = await context.trust.agentPolicySha256(workspaceId, revision);
  if (pinned !== undefined && pinned !== policySha256) {
    return { status: "policy_mismatch", revision };
  }
  // the agent may never name a revision below the floor the owner signed into its agent_key
  const floor = Math.max(
    0,
    ...(await context.verifier.agentKeys.forToken(fields.tokenId)).map((key) => key.policyRevision),
  );
  if (revision < floor) return { status: "below_floor", revision, floor };
  const lookup = options.folders ?? knownFolders(context);
  const modeUnder = (rules: AgentPolicyRules | null) =>
    lookup(folderId) === undefined
      ? null
      : effectiveMode(rules, agentPolicyAncestry(folderId, lookup));
  if (revision === 0) {
    return policySha256 === MISSING_AGENT_POLICY_SHA256
      ? { status: "consistent", revision, mode: modeUnder(null) }
      : { status: "policy_mismatch", revision };
  }
  let checked: CheckedAgentPolicy;
  try {
    checked = await readAgentPolicy(context, {
      revision,
      ...(options.visibleFolderIds === undefined
        ? {}
        : { visibleFolderIds: options.visibleFolderIds }),
    });
  } catch (error) {
    if (isSyncApiError(error, "not_found")) {
      return { status: "unverifiable", revision, problem: "not_found" };
    }
    throw error;
  }
  const { resolved } = checked;
  if (!resolved.ok) return { status: "unverifiable", revision, problem: resolved.problem };
  if (resolved.policySha256 !== policySha256) return { status: "policy_mismatch", revision };
  return { status: "consistent", revision, mode: modeUnder(resolved.rules) };
}

/*
 * Protocol 3: an agent's own signed note deletes and folder changes, each on its agent route with
 * the policy revision it checked and the scope revision it acts under (`scopeRevision`, from its
 * verified `agent_scope`; the CLI's `WorkspaceSession` knows it). The same checks as
 * `writeAsAgent` come first: the agent's key is the one the owner vouched for, the policy verifies
 * and every folder whose contents change (the top level reads the default) is `direct`. The
 * server enforces the permissions and the scope; a `stale_agent_scope` or `permission_required`
 * answer is thrown, for the caller to read its token again.
 */

/** What every agent action of protocol 3 takes besides its own fields. */
export interface AgentActionOptions {
  /** The scope revision the agent acts under (its verified `agent_scope`'s). */
  readonly scopeRevision: number;
  /** As for `writeAsAgent`: the caller's pinned policy floor. */
  readonly minPolicyRevision?: number;
  /** As for `writeAsAgent`: looks folders up for the policy's ancestry. */
  readonly folders?: AgentPolicyFolderLookup;
  /** As for `writeAsAgent`: more folders the caller sees, none of whose overrides may hide. */
  readonly visibleFolderIds?: Iterable<string>;
  /** When to sign (see `SigningTime`); defaults to now. */
  readonly signedAt?: string;
}

/** What an agent action signs with, once the checks passed. */
interface AgentActionSigning {
  readonly signer: AgentSigner;
  readonly own: readonly VerifiedAgentKey[];
  readonly revisions: AgentActionRevisions;
}

/**
 * Runs an agent action of protocol 3 after `writeAsAgent`'s checks, for the folders `touched`
 * (null: the top level, which reads the default): a refusal instead when one fails, and once
 * more after `stale_agent_policy`. `approval_required`, `agent_key_required` and `rate_limited`
 * from the server come back as refusals; anything else is thrown.
 */
async function runAgentAction<T>(
  context: SyncContext,
  route: string,
  options: AgentActionOptions,
  touched: readonly (string | null)[],
  send: (signing: AgentActionSigning) => Promise<T>,
): Promise<T | AgentActionRefusal> {
  if (context.agent === undefined) return { status: "agent_key_required" };
  const { agent, signer } = requireAgent(context, route);
  const own = await ownKeys(context, agent);
  if (own.length === 0) return { status: "agent_key_required" };
  const floor = Math.max(options.minPolicyRevision ?? 0, ...own.map((key) => key.policyRevision));
  const lookup = options.folders ?? knownFolders(context);
  const folders = [...new Set(touched.filter((folderId) => folderId !== null))];
  if (folders.some((folderId) => lookup(folderId) === undefined)) {
    return { status: "approval_required", reason: "unknown_folder", policyRevision: null };
  }
  const topLevel = touched.includes(null);
  const ancestries = folders.map((folderId) => agentPolicyAncestry(folderId, lookup));
  const visible = new Set([
    ...(options.visibleFolderIds ?? []),
    ...context.folders.keys(),
    ...ancestries.flatMap((ancestry) =>
      ancestry.filter((folder) => folder.unknown !== true).map((folder) => folder.folderId),
    ),
  ]);
  let lastRevision: number | null = null;
  const attempt = async (retried: boolean): Promise<T | AgentActionRefusal> => {
    const { resolved } = await fetchAgentPolicy(context.api, policyTrust(context, floor, visible));
    if (!resolved.ok) {
      return {
        status: "approval_required",
        reason: "unverified_policy",
        policyRevision: null,
        problem: resolved.problem,
      };
    }
    lastRevision = resolved.revision;
    const asksFirst =
      (topLevel && resolved.rules.default !== "direct") ||
      ancestries.some((ancestry) => effectiveMode(resolved.rules, ancestry) !== "direct");
    if (asksFirst) {
      return { status: "approval_required", reason: "policy", policyRevision: resolved.revision };
    }
    try {
      return await send({
        signer,
        own,
        revisions: {
          revision: resolved.revision,
          policySha256: resolved.policySha256,
          scopeRevision: options.scopeRevision,
        },
      });
    } catch (error) {
      if (isSyncApiError(error, "stale_agent_policy") && !retried) return attempt(true);
      throw error;
    }
  };
  try {
    return await attempt(false);
  } catch (error) {
    if (isSyncApiError(error, "approval_required")) {
      return { status: "approval_required", reason: "server", policyRevision: lastRevision };
    }
    if (isSyncApiError(error, "agent_key_required")) return { status: "agent_key_required" };
    if (isSyncApiError(error, "rate_limited")) {
      const { detail } = error;
      return {
        status: "rate_limited",
        retryAfterSeconds: detail.code === "rate_limited" ? detail.retryAfterSeconds : null,
      };
    }
    throw error;
  }
}

/** An agent's note delete (protocol 3, `notes.delete`). */
export interface AgentNoteDelete extends AgentActionOptions {
  readonly noteId: NoteId;
  /** The version the agent read: the delete marker becomes the next one. */
  readonly baseVersion: number;
  /** Appends the agent's unsigned `wrote` record for the marker (who, and why). Best effort. */
  readonly record?: { readonly actor: string; readonly summary?: string };
}

/**
 * An agent deletes a note directly (protocol 3), signed with its own key (`agent_deleted`), where
 * the note's folder is `direct`: `writeAsAgent`'s checks and refusals (propose the delete instead
 * with `proposeDelete` on `approval_required`, `agent_key_required` or the daily cap), and both
 * sides on a 409. The note's folder must be one the engine knows (else `unknown_folder`).
 */
export async function deleteAsAgent(
  context: SyncContext,
  target: AgentNoteDelete,
): Promise<AgentWriteResult> {
  const { workspaceId } = context;
  const folderId = context.noteFolders.get(target.noteId);
  if (folderId === undefined) {
    return { status: "approval_required", reason: "unknown_folder", policyRevision: null };
  }
  let result: AgentWriteResult;
  try {
    result = await runAgentAction(
      context,
      "deleteNoteAsAgent",
      target,
      [folderId],
      async ({ signer, own, revisions }) => {
        const action = signAgentDeleted(signer, {
          workspaceId,
          noteId: target.noteId,
          folderId,
          baseVersion: target.baseVersion,
          ...revisions,
          ...(target.signedAt === undefined ? {} : { signedAt: target.signedAt }),
        });
        const { data } = await context.api.call(routes.deleteNoteAsAgent, {
          params: { workspaceId, noteId: target.noteId },
          headers: {
            "if-match": formatVersionTag(target.baseVersion),
            ...signingHeaders(action),
            "knowtarium-agent-policy-revision": String(revisions.revision),
            "knowtarium-agent-scope-revision": String(revisions.scopeRevision),
          },
        });
        checkStoredWrite(context, data, target, own);
        const note = await acceptNote(context, {
          noteId: target.noteId,
          folderId: data.note.folderId,
          version: data.note.currentVersion,
          name: null,
          text: null,
          createdAt: data.note.createdAt,
          event: data.event,
          agentKeys: own,
        });
        return {
          status: "saved" as const,
          note,
          workspaceVersion: data.workspaceVersion,
          policyRevision: revisions.revision,
          recorded: false,
        };
      },
    );
  } catch (error) {
    if (!isSyncApiError(error, "conflict")) throw error;
    const conflict = await conflictResult(context, target.noteId, {
      baseVersion: target.baseVersion,
      name: null,
      text: null,
    });
    return { ...conflict, currentVersion: conflict.theirs.version } satisfies AgentWriteConflict;
  }
  if (result.status !== "saved" || target.record === undefined) return result;
  return {
    ...result,
    recorded: await recordWrote(context, target.noteId, result, { record: target.record }),
  };
}

/**
 * An agent proposes deleting a note (protocol 3, `notes.delete`) where its folder asks first:
 * a delete proposal at `baseVersion` (the version it read), unsigned, for a person to approve with
 * their own signed delete. Both sides on a 409.
 */
export async function proposeDelete(
  context: SyncContext,
  target: { readonly noteId: NoteId; readonly baseVersion: number },
): Promise<SubmitResult> {
  if (context.api.auth.kind !== "agent") {
    throw new RequestValidationError("proposeNoteDelete", "auth");
  }
  try {
    const { data } = await context.api.call(routes.proposeNoteDelete, {
      params: { workspaceId: context.workspaceId, noteId: target.noteId },
      headers: {
        "if-match": formatVersionTag(target.baseVersion),
        "knowtarium-pending-nonce": newPendingNonce(),
      },
    });
    return { status: "submitted", pending: data.pending };
  } catch (error) {
    if (!isSyncApiError(error, "conflict")) throw error;
    return conflictResult(context, target.noteId, {
      baseVersion: target.baseVersion,
      name: null,
      text: null,
    });
  }
}

/** Reports a folder the server stored for this agent's change, as the feed would. */
async function reportFolder(context: SyncContext, folder: Folder): Promise<void> {
  const name = await withKeys(context, (keys) =>
    decryptFolderName(
      keys,
      { workspaceId: context.workspaceId, folderId: folder.id },
      folder.encName,
    ),
  );
  context.emitter.emit({
    type: "folder",
    folder: {
      folderId: folder.id,
      parentId: folder.parentId,
      name,
      deleted: false,
      createdAt: folder.createdAt,
    },
  });
}

/** A folder name an agent gives: the empty name is the workspace root's own. */
function folderName(route: string, name: string): string {
  if (name === ROOT_FOLDER_NAME) throw new RequestValidationError(route, "body", ["encName"]);
  return name;
}

/**
 * An agent creates a folder (protocol 3, `folders.create`) under `parentId` (null: the top level,
 * which only a whole-workspace token may use), signed `agent_folder_created`, where the parent
 * (or the default, at the top level) is `direct`. With `folderId`, the ID of a deleted folder, it
 * revives it where it was (`parentId` must be its stored parent). The folder is reported as the
 * feed would report it. Folder changes are never proposed: a refusal means telling the person.
 */
export async function createFolderAsAgent(
  context: SyncContext,
  change: AgentActionOptions & {
    readonly parentId: FolderId | null;
    readonly name: string;
    readonly folderId?: FolderId;
  },
): Promise<AgentFolderResult> {
  const { workspaceId } = context;
  const name = folderName("createFolderAsAgent", change.name);
  const folderId = change.folderId ?? newId("fld");
  return runAgentAction(
    context,
    "createFolderAsAgent",
    change,
    [change.parentId],
    ({ signer, revisions }) =>
      withCurrentKey(context, async (keys) => {
        const encName = encryptFolderName(keys.current, { workspaceId, folderId }, name);
        const action = signAgentFolderCreated(signer, {
          workspaceId,
          folderId,
          parentId: change.parentId,
          encName: fromBase64Url(encName),
          ...revisions,
          ...(change.signedAt === undefined ? {} : { signedAt: change.signedAt }),
        });
        const { data } = await context.api.call(routes.createFolderAsAgent, {
          params: { workspaceId },
          body: {
            id: folderId,
            parentId: change.parentId,
            encName,
            policyRevision: revisions.revision,
            scopeRevision: revisions.scopeRevision,
            ...signingFields(action),
          },
        });
        await reportFolder(context, data.folder);
        return {
          status: "saved" as const,
          folder: data.folder,
          workspaceVersion: data.workspaceVersion,
          policyRevision: revisions.revision,
        };
      }),
  );
}

/** The parent of a folder the engine (or `folders`) knows; undefined when it doesn't know it. */
function parentOf(
  context: SyncContext,
  options: AgentActionOptions,
  folderId: string,
): string | null | undefined {
  return (options.folders ?? knownFolders(context))(folderId)?.parentId;
}

/**
 * An agent renames a folder (protocol 3, `folders.rename`), signed `agent_folder_renamed`, where
 * the folder and its parent are `direct`.
 */
export async function renameFolderAsAgent(
  context: SyncContext,
  change: AgentActionOptions & { readonly folderId: FolderId; readonly name: string },
): Promise<AgentFolderResult> {
  const { workspaceId } = context;
  const name = folderName("renameFolderAsAgent", change.name);
  const parent = parentOf(context, change, change.folderId);
  if (parent === undefined) {
    return { status: "approval_required", reason: "unknown_folder", policyRevision: null };
  }
  return runAgentAction(
    context,
    "renameFolderAsAgent",
    change,
    [change.folderId, parent],
    ({ signer, revisions }) =>
      withCurrentKey(context, async (keys) => {
        const encName = encryptFolderName(
          keys.current,
          { workspaceId, folderId: change.folderId },
          name,
        );
        const action = signAgentFolderRenamed(signer, {
          workspaceId,
          folderId: change.folderId,
          parentId: parent,
          encName: fromBase64Url(encName),
          ...revisions,
          ...(change.signedAt === undefined ? {} : { signedAt: change.signedAt }),
        });
        const { data } = await context.api.call(routes.renameFolderAsAgent, {
          params: { workspaceId, folderId: change.folderId },
          body: {
            encName,
            policyRevision: revisions.revision,
            scopeRevision: revisions.scopeRevision,
            ...signingFields(action),
          },
        });
        await reportFolder(context, data.folder);
        return {
          status: "saved" as const,
          folder: data.folder,
          workspaceVersion: data.workspaceVersion,
          policyRevision: revisions.revision,
        };
      }),
  );
}

/**
 * An agent moves a folder, with everything in it, under `parentId` (protocol 3, `folders.move`;
 * null: the top level, only for a whole-workspace token), signed `agent_folder_moved`, where the
 * folder, its current parent and the new parent are `direct`.
 */
export async function moveFolderAsAgent(
  context: SyncContext,
  change: AgentActionOptions & { readonly folderId: FolderId; readonly parentId: FolderId | null },
): Promise<AgentFolderResult> {
  const { workspaceId } = context;
  const parent = parentOf(context, change, change.folderId);
  if (parent === undefined) {
    return { status: "approval_required", reason: "unknown_folder", policyRevision: null };
  }
  return runAgentAction(
    context,
    "moveFolderAsAgent",
    change,
    [change.folderId, parent, change.parentId],
    async ({ signer, revisions }) => {
      const action = signAgentFolderMoved(signer, {
        workspaceId,
        folderId: change.folderId,
        parentId: change.parentId,
        fromParentId: parent,
        ...revisions,
        ...(change.signedAt === undefined ? {} : { signedAt: change.signedAt }),
      });
      const { data } = await context.api.call(routes.moveFolderAsAgent, {
        params: { workspaceId, folderId: change.folderId },
        body: {
          parentId: change.parentId,
          policyRevision: revisions.revision,
          scopeRevision: revisions.scopeRevision,
          ...signingFields(action),
        },
      });
      await reportFolder(context, data.folder);
      return {
        status: "saved" as const,
        folder: data.folder,
        workspaceVersion: data.workspaceVersion,
        policyRevision: revisions.revision,
      };
    },
  );
}

/**
 * An agent deletes an empty folder (protocol 3, `folders.delete`), signed
 * `agent_folder_deleted`, where the folder and its parent are `direct`. The server answers
 * `not_empty` (thrown) while it holds a folder, a note, a file or a recent unfinished upload.
 */
export async function deleteFolderAsAgent(
  context: SyncContext,
  change: AgentActionOptions & { readonly folderId: FolderId },
): Promise<
  | { readonly status: "saved"; readonly workspaceVersion: number; readonly policyRevision: number }
  | AgentActionRefusal
> {
  const { workspaceId } = context;
  const parent = parentOf(context, change, change.folderId);
  if (parent === undefined) {
    return { status: "approval_required", reason: "unknown_folder", policyRevision: null };
  }
  return runAgentAction(
    context,
    "deleteFolderAsAgent",
    change,
    [change.folderId, parent],
    async ({ signer, revisions }) => {
      const action = signAgentFolderDeleted(signer, {
        workspaceId,
        folderId: change.folderId,
        parentId: parent,
        ...revisions,
        ...(change.signedAt === undefined ? {} : { signedAt: change.signedAt }),
      });
      const { data } = await context.api.call(routes.deleteFolderAsAgent, {
        params: { workspaceId, folderId: change.folderId },
        headers: {
          ...signingHeaders(action),
          "knowtarium-agent-policy-revision": String(revisions.revision),
          "knowtarium-agent-scope-revision": String(revisions.scopeRevision),
        },
      });
      context.emitter.emit({
        type: "folder",
        folder: {
          folderId: change.folderId,
          parentId: parent === null ? null : (parent as FolderId),
          name: null,
          deleted: true,
          createdAt: null,
        },
      });
      return {
        status: "saved" as const,
        workspaceVersion: data.workspaceVersion,
        policyRevision: revisions.revision,
      };
    },
  );
}

/**
 * The agents' direct writes, note deletes and folder changes of the last `sinceMs` milliseconds
 * (by when each was signed), newest first, each verified under its agent's vouched key (anything
 * that doesn't verify is left out); only one agent's with `tokenId`. For a person's list of an
 * agent's changes, with `auditAgentAction` and the undo helpers.
 */
export async function listAgentActions(
  context: SyncContext,
  options: { readonly sinceMs: number; readonly tokenId?: string; readonly now?: number },
): Promise<AgentAction[]> {
  const { workspaceId } = context;
  const since = (options.now ?? Date.now()) - options.sinceMs;
  const recent = (createdAt: string) => Date.parse(createdAt) >= since;
  const wanted = (tokenId: string) => options.tokenId === undefined || options.tokenId === tokenId;
  const actions: AgentAction[] = [];
  for (const event of await fetchEvents(context, {})) {
    const fields = event.signed?.envelope;
    if (fields?.type !== "agent_edited" && fields?.type !== "agent_deleted") continue;
    if (!wanted(fields.tokenId) || !recent(fields.createdAt)) continue;
    const keys = await context.verifier.agentKeys.forToken(fields.tokenId);
    if (!eventSignatureValid(event, workspaceId, context.verifier.owner, keys)) continue;
    actions.push({
      kind: fields.type === "agent_edited" ? "edited" : "deleted",
      tokenId: fields.tokenId,
      createdAt: fields.createdAt,
      noteId: fields.noteId,
      version: fields.version,
      folderId: fields.folderId,
      event,
    });
  }
  for (const entry of await fetchFolderEvents(context)) {
    const fields = entry.event.signed?.envelope;
    if (entry.agent === null || fields === undefined || !recent(fields.createdAt)) continue;
    if (!wanted(entry.agent.tokenId)) continue;
    actions.push({
      kind: "folder",
      tokenId: entry.agent.tokenId,
      createdAt: fields.createdAt,
      folderId: entry.event.folderId,
      entry,
    });
  }
  return actions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The permission each agent action needs. */
const PERMISSION_OF: Partial<Record<string, AgentPermission>> = {
  agent_deleted: "notes.delete",
  agent_folder_created: "folders.create",
  agent_folder_renamed: "folders.rename",
  agent_folder_moved: "folders.move",
  agent_folder_deleted: "folders.delete",
};

/**
 * Whether a scope's write reach holds a folder (null: the top level, only a whole-workspace
 * scope): `read-write`, and the folder is one of its folders or under one.
 */
function reaches(
  scope: AgentScopeBody,
  folderId: string | null,
  lookup: AgentPolicyFolderLookup,
): boolean | null {
  if (scope.access !== "read-write") return false;
  if (scope.folderIds.length === 0) return true;
  if (folderId === null) return false;
  const ancestry = agentPolicyAncestry(folderId, lookup);
  if (
    ancestry.some(
      (folder) => folder.unknown !== true && scope.folderIds.includes(folder.folderId as FolderId),
    )
  ) {
    return true;
  }
  // a chain cut off by an unknown folder: the caller doesn't know the tree well enough
  return ancestry.some((folder) => folder.unknown === true) ? null : false;
}

/** The parents an agent's folder change signed: `parentId` and `fromParentId` (null: the top level). */
function signedParents(entry: FolderEventEntry): {
  readonly parentId: string | null;
  readonly fromParentId: string | null;
} {
  const fields = entry.event.signed?.envelope as
    { readonly parentId?: string; readonly fromParentId?: string } | undefined;
  return { parentId: fields?.parentId ?? null, fromParentId: fields?.fromParentId ?? null };
}

/**
 * The folders an action touched, from what the agent signed (never the server's word): for the
 * scope's reach (a note delete's folder, a create's parent, a revive's own folder, a rename's or
 * a folder delete's folder, a move's folder and both parents) and for the modes table (every
 * folder whose contents change: a note delete's folder, a create's or revive's parent, a rename's
 * or a folder delete's folder and parent, a move's folder and both parents). Null is the top
 * level.
 */
function touchedBy(action: AgentAction): {
  readonly reach: (string | null)[];
  readonly modes: (string | null)[];
} {
  if (action.kind !== "folder") return { reach: [action.folderId], modes: [action.folderId] };
  const { event } = action.entry;
  const { parentId, fromParentId } = signedParents(action.entry);
  switch (event.action) {
    case "created":
      return { reach: [parentId], modes: [parentId] };
    case "restored":
      // a revive needs the scope on the deleted folder's own place, never another
      return { reach: [event.folderId], modes: [parentId] };
    case "moved":
      return {
        reach: [event.folderId, fromParentId, parentId],
        modes: [event.folderId, fromParentId, parentId],
      };
    case "renamed":
    case "deleted":
      return { reach: [event.folderId], modes: [event.folderId, parentId] };
  }
}

/**
 * Audits an agent's protocol 3 action (a note delete or a folder change, from `agentActions`)
 * against the scope revisions the owner signed for its token (`fetchTokenScopes`, read with the
 * device's floor): the revision R the action names must be the one in force when it was signed,
 * allowing for the clock skew a signature may have (`SIGNATURE_MAX_SKEW_SECONDS`): R signed no
 * later than the action's time plus the skew, and R + 1, if any, no earlier than its time minus
 * the skew (so an action in flight while the owner signs R + 1 isn't flagged). R's scope must
 * hold the action's permission and reach every folder the action touched (the folder, a create's
 * parent, both parents of a move). The policy part is checked as for edits (`auditAgentVersion`'s
 * rule), and every folder whose contents changed must have been `direct` under that policy
 * revision, as these actions are only ever allowed there. A list with a gap, below the floor, or
 * of another token's scopes is `unchecked`, as is an action whose folders aren't known (`folders`,
 * defaulting to the engine's). The reach and the modes are judged on today's folder tree (a
 * folder moved since may read differently; the folder history has the moves). For display: the
 * server enforces the scope.
 */
export async function auditAgentAction(
  context: SyncContext,
  action: AgentAction,
  scopes: TokenScopes,
  options: {
    readonly folders?: AgentPolicyFolderLookup;
    readonly visibleFolderIds?: Iterable<string>;
  } = {},
): Promise<AgentActionAudit> {
  const signed = action.kind === "folder" ? action.entry.event.signed : action.event.signed;
  const fields = signed?.envelope;
  const permission = fields === undefined ? undefined : PERMISSION_OF[fields.type];
  if (fields === undefined || permission === undefined || !("scopeRevision" in fields)) {
    return { verdict: "unchecked", reason: "not_agent_action" };
  }
  if (scopes.scopes.some((scope) => scope.signed.envelope.tokenId !== fields.tokenId)) {
    return { verdict: "unchecked", reason: "other_token" };
  }
  if (scopes.problem !== null) return { verdict: "unchecked", reason: scopes.problem };
  const at = Date.parse(fields.createdAt);
  const skew = SIGNATURE_MAX_SKEW_SECONDS * 1000;
  const revision = fields.scopeRevision;
  const named = scopes.scopes.find((scope) => scope.revision === revision);
  if (named === undefined) {
    return { verdict: "not_allowed", scopeRevision: revision, reason: "no_scope" };
  }
  const notAllowed = (reason: "other_revision" | "permission" | "folders" | "policy") =>
    ({ verdict: "not_allowed", scopeRevision: revision, reason }) as const;
  const next = scopes.scopes.find((scope) => scope.revision === revision + 1);
  if (Date.parse(named.signedAt) > at + skew) return notAllowed("other_revision");
  if (next !== undefined && Date.parse(next.signedAt) < at - skew) {
    return notAllowed("other_revision");
  }
  if (!agentScopeAllows(named.scope, permission)) return notAllowed("permission");
  const lookup = options.folders ?? knownFolders(context);
  const touched = touchedBy(action);
  const reach = touched.reach.map((folderId) => reaches(named.scope, folderId, lookup));
  if (reach.includes(false)) return notAllowed("folders");
  if (reach.includes(null)) return { verdict: "unchecked", reason: "unknown_folder" };
  const audited = await auditPolicyRevision(context, fields, options);
  if (audited.audit.status !== "consistent") {
    return { ...notAllowed("policy"), policy: audited.audit };
  }
  const { rules } = audited;
  const modes: (AgentWriteMode | null)[] = touched.modes.map((folderId) =>
    folderId === null
      ? (rules?.default ?? "direct")
      : lookup(folderId) === undefined
        ? null
        : effectiveMode(rules, agentPolicyAncestry(folderId, lookup)),
  );
  if (modes.includes(null)) return { verdict: "unchecked", reason: "unknown_folder" };
  const mode: AgentWriteMode = modes.every((each) => each === "direct") ? "direct" : "review";
  const policy: AgentWriteAudit = { status: "consistent", revision: audited.audit.revision, mode };
  if (mode !== "direct") return { ...notAllowed("policy"), policy };
  return { verdict: "allowed", scopeRevision: revision, policy };
}

/**
 * `auditAgentVersion`'s policy rule for any agent-signed envelope: the owner-signed hash of the
 * revision it names (and this device's pin) must be the one it signed, never below its key's
 * floor. Answers the audit (with `mode` null: the caller judges the modes) and that revision's
 * rules (null at revision 0, the missing policy: direct everywhere).
 */
async function auditPolicyRevision(
  context: SyncContext,
  fields: { readonly tokenId: string; readonly revision: number; readonly policySha256: string },
  options: { readonly visibleFolderIds?: Iterable<string> },
): Promise<{ readonly audit: AgentWriteAudit; readonly rules: AgentPolicyRules | null }> {
  const { revision, policySha256 } = fields;
  const answer = (audit: AgentWriteAudit, rules: AgentPolicyRules | null = null) => ({
    audit,
    rules,
  });
  const pinned = await context.trust.agentPolicySha256(context.workspaceId, revision);
  if (pinned !== undefined && pinned !== policySha256) {
    return answer({ status: "policy_mismatch", revision });
  }
  const floor = Math.max(
    0,
    ...(await context.verifier.agentKeys.forToken(fields.tokenId)).map((key) => key.policyRevision),
  );
  if (revision < floor) return answer({ status: "below_floor", revision, floor });
  if (revision === 0) {
    return answer(
      policySha256 === MISSING_AGENT_POLICY_SHA256
        ? { status: "consistent", revision, mode: null }
        : { status: "policy_mismatch", revision },
    );
  }
  let checked: CheckedAgentPolicy;
  try {
    checked = await readAgentPolicy(context, {
      revision,
      ...(options.visibleFolderIds === undefined
        ? {}
        : { visibleFolderIds: options.visibleFolderIds }),
    });
  } catch (error) {
    if (isSyncApiError(error, "not_found")) {
      return answer({ status: "unverifiable", revision, problem: "not_found" });
    }
    throw error;
  }
  const { resolved } = checked;
  if (!resolved.ok) return answer({ status: "unverifiable", revision, problem: resolved.problem });
  if (resolved.policySha256 !== policySha256) {
    return answer({ status: "policy_mismatch", revision });
  }
  return answer({ status: "consistent", revision, mode: null }, resolved.rules);
}
