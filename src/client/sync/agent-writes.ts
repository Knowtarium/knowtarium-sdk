import { normalizeNoteName } from "../../core/files/index.js";
import { toBase64Url } from "../../crypto/index.js";
import {
  type AgentEditedEnvelope,
  type AgentPolicyFolder,
  type AgentPolicyFolderLookup,
  type AgentPolicyRules,
  agentPolicyAncestry,
  type AgentWriteMode,
  effectiveMode,
  formatVersionTag,
  MISSING_AGENT_POLICY_SHA256,
  type NoteId,
  routes,
} from "../../protocol/index.js";
import { isSyncApiError, RequestValidationError, VaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import {
  type AgentPolicyTrust,
  type CheckedAgentPolicy,
  checkAgentPolicy,
  encryptEvent,
  encryptNote,
  fetchAgentPolicy,
  prepareAgentPolicy,
  signAgentEdited,
  signingHeaders,
  type VerifiedAgentKey,
} from "../vault/index.js";
import { eventSignatureValid } from "../history/verify.js";
import {
  type AgentConnection,
  requireAgent,
  requireIdentity,
  type SyncContext,
  withCurrentKey,
} from "./context.js";
import { acceptNote, checkStoredWrite, fetchEvents } from "./notes.js";
import type {
  AgentWriteAudit,
  AgentWriteConflict,
  AgentWriteResult,
  SetAgentPolicyResult,
} from "./results.js";
import { conflictResult, type NoteWrite } from "./writes.js";

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
    if (!isSyncApiError(error, "conflict")) throw error;
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
  write: AgentNoteWrite,
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
