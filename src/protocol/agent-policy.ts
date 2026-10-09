import { z } from "zod";

import { canonicalJson } from "./canonical.js";
import { AccountId, FolderId } from "./ids.js";
import { QueryVersion, Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";
import { AgentPolicySha256, requiredSigningFields, SignedAgentPolicy } from "./signatures.js";

/*
 * How agents' writes land in a workspace (protocol 2). `direct`: an agent's write becomes the
 * next note version right away (`writeNoteAsAgent`, signed with the agent's own key), with undo
 * as the safety net. `review` ("ask me first"): the agent proposes (`submitPending`) and a person
 * approves. The workspace has a default and per-folder overrides; for a note, the nearest folder
 * up its ancestry with an override wins, otherwise the default applies (`effectiveMode`). The
 * server enforces it: `writeNoteAsAgent` answers `approval_required` where the mode is `review`
 * (for a move, in either the old or the new folder), and the CLI falls back to proposing.
 * `submitPending` stays allowed in every mode. Agents never delete notes directly, in any mode.
 *
 * An override covers its folder and every folder stored under it, nothing else. The workspace
 * root folder (core's `rootFolderOf`, a top-level folder with an empty name) is an ordinary folder
 * here: an override on it covers the notes and folders stored under it, never the other top-level
 * folders (`parentId` null). "The whole workspace" is `default`.
 *
 * Only the owner sets the policy (`setAgentPolicy`), signing `agent_policy` with the new revision
 * and `agentPolicySha256` of its rules, so the CLI and the web app can check the policy they read
 * against the owner's key and a server can't flip a folder to direct on its own. A workspace that
 * never had a policy reads as `missingAgentPolicy()`: direct, revision 0, unsigned. The server
 * keeps every revision: `getAgentPolicy` with `?revision=` returns an old one, so a verifier can
 * check an `agent_edited` against the policy it named.
 *
 * An agent reads a view (`agentPolicyViewFor`, which the server and the web app both use): the
 * overrides inside its scope (its folders and their subfolders; all of them for a whole-workspace
 * token) in `folders`, the hash of every other override in `otherFolderHashes`, and for each of the
 * token's folders the ids of the folders above it in `ancestors` (random ids, no names). The agent
 * checks the view with `resolveAgentPolicyView`, which every client shares:
 *
 * - the owner's signature on the hash of `default`, `folders` and `otherFolderHashes`, so no
 *   override can be added, dropped or changed;
 * - no visible folder's override hides among the hashes (each visible folder id is hashed with
 *   both modes and must not be there), so the server can't hide a `review` it owes the agent;
 * - each ancestor's mode, derived by the agent itself from the hashes, so the server can't assert
 *   what the agent inherits;
 * - a floor: never a revision below the `policyRevision` the owner signed into the agent's
 *   `agent_key` at connect time, nor below the highest revision the CLI has seen (it pins that;
 *   see t-86), so an old policy can't be replayed;
 * - one policy per revision: clients pin the hash they verified at each recent revision and
 *   refuse another owner-signed one there (`equivocation`, the caller's check, not the
 *   resolver's), so a fork the owner was led to sign over an older policy can't replace it.
 *
 * Any problem reads as `review`. The gap left: the folder parent chain (`ancestors`, and which
 * folders an agent sees) is server-asserted. Signed folder events exist but aren't shipped to
 * agents. Lying there is a larger lie than flipping a mode, and the web app, which sees the full
 * tree, can detect it. The same goes for a folder's `deleted` flag, which only the server knows:
 * a deleted folder inside a live note's ancestry can't happen (only an empty folder can be
 * deleted), so it reads as `review`, while overrides left on deleted folders outside every live
 * ancestry simply never apply.
 */

/** How an agent's write lands: as a new version right away, or as a proposal to review. */
export const AgentWriteMode = z.enum(["direct", "review"]);
export type AgentWriteMode = z.infer<typeof AgentWriteMode>;

/** The mode of a workspace with no policy (and of `missingAgentPolicy()`). */
export const DEFAULT_AGENT_WRITE_MODE: AgentWriteMode = "direct";

/** The most folder overrides a policy holds. */
export const AGENT_POLICY_FOLDERS_MAX = 1000;

/** The most entries in one `ancestors` list (and the most folders above one scope folder). */
export const AGENT_POLICY_ANCESTORS_MAX = 1000;

/** One folder's override; it applies to the folder and every folder below it without its own. */
export const AgentPolicyFolder = z.strictObject({ folderId: FolderId, mode: AgentWriteMode });
export type AgentPolicyFolder = z.infer<typeof AgentPolicyFolder>;

const isUnique = (values: readonly string[]) => new Set(values).size === values.length;

/** A policy's folder overrides: at most `AGENT_POLICY_FOLDERS_MAX`, one per folder. */
export const AgentPolicyFolders = z
  .array(AgentPolicyFolder)
  .max(AGENT_POLICY_FOLDERS_MAX)
  .refine((folders) => isUnique(folders.map((folder) => folder.folderId)), {
    error: "One override per folder",
  });

/** One of an agent token's folders and the folders above it, parent first, up to the top level. */
export const AgentPolicyAncestors = z
  .strictObject({
    folderId: FolderId,
    /** The parent, its parent and so on; empty for a top-level folder. */
    ancestorIds: z.array(FolderId).max(AGENT_POLICY_ANCESTORS_MAX),
  })
  .refine((entry) => isUnique(entry.ancestorIds) && !entry.ancestorIds.includes(entry.folderId), {
    error: "A folder appears once in its own ancestry",
  });
export type AgentPolicyAncestors = z.infer<typeof AgentPolicyAncestors>;

/**
 * A workspace's agent policy (one revision of it), with the owner's signed `agent_policy`.
 * `revision` is bumped by every `setAgentPolicy`; revision 0 (and only revision 0) has
 * `updatedAt`, `updatedBy` and `signed` null: the workspace never had a policy. For an agent
 * caller it is a view (`agentPolicyViewFor`): `folders` holds only the overrides inside its scope,
 * and `otherFolderHashes` and `ancestors` are set.
 */
export const AgentPolicy = z
  .object({
    default: AgentWriteMode,
    folders: AgentPolicyFolders,
    revision: Version,
    updatedAt: Timestamp.nullable(),
    updatedBy: AccountId.nullable(),
    signed: SignedAgentPolicy.nullable(),
    /** For an agent: `agentPolicyFolderHash` of every override outside its scope. */
    otherFolderHashes: z.array(AgentPolicySha256).max(AGENT_POLICY_FOLDERS_MAX).optional(),
    /** For an agent: each of the token's folders with the folders above it. */
    ancestors: z.array(AgentPolicyAncestors).max(AGENT_POLICY_ANCESTORS_MAX).optional(),
  })
  .refine(
    (policy) =>
      policy.folders.length + (policy.otherFolderHashes?.length ?? 0) <= AGENT_POLICY_FOLDERS_MAX,
    { error: `At most ${String(AGENT_POLICY_FOLDERS_MAX)} overrides in all` },
  )
  .refine(
    (policy) =>
      [policy.signed, policy.updatedAt, policy.updatedBy].every(
        (field) => (field === null) === (policy.revision === 0),
      ),
    { error: "Revision 0, and only revision 0, is unsigned with no update time or author" },
  )
  .refine(
    (policy) => policy.signed === null || policy.signed.envelope.revision === policy.revision,
    {
      error: "The signed revision is the policy's revision",
    },
  )
  .refine((policy) => isUnique(policy.otherFolderHashes ?? []), { error: "A hash appears once" })
  .refine((policy) => isUnique((policy.ancestors ?? []).map((entry) => entry.folderId)), {
    error: "One ancestors entry per folder",
  });
export type AgentPolicy = z.infer<typeof AgentPolicy>;

/** The policy of a workspace that never had one: direct everywhere, revision 0, unsigned. */
export function missingAgentPolicy(): AgentPolicy {
  return {
    default: DEFAULT_AGENT_WRITE_MODE,
    folders: [],
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    signed: null,
  };
}

/**
 * `agentPolicySha256(missingAgentPolicy())`: what an `agent_edited` signs as `policySha256` in a
 * workspace with no policy yet (revision 0).
 */
export const MISSING_AGENT_POLICY_SHA256 =
  "0524a604152409eee80717dc42198b639826651a1e20e99ae88e0f1d6b947017";

/**
 * `getAgentPolicy` without a query returns the current revision; with `revision` that one (404
 * `not_found` for a revision that never was), for checking an `agent_edited` that named it.
 */
export const AgentPolicyQuery = z.strictObject({ revision: QueryVersion.optional() });
export type AgentPolicyQuery = z.infer<typeof AgentPolicyQuery>;

export const AgentPolicyResponse = z.object({ policy: AgentPolicy });
export type AgentPolicyResponse = z.infer<typeof AgentPolicyResponse>;

/**
 * The owner replaces the whole policy. The server answers 409 `conflict` (with `currentVersion`
 * = the current policy revision) unless `baseRevision` is still current, then rebuilds and
 * verifies `agent_policy` with `revision` = `baseRevision + 1` and `agentPolicySha256` of this
 * `default` and `folders`, and stores the policy with that signature (keeping the old revisions).
 */
export const SetAgentPolicyRequest = z.strictObject({
  default: AgentWriteMode,
  folders: AgentPolicyFolders,
  /** The revision the owner edited; 0 for a workspace with no policy yet. */
  baseRevision: Version,
  ...requiredSigningFields,
});
export type SetAgentPolicyRequest = z.infer<typeof SetAgentPolicyRequest>;

/** The stored policy and the workspace version its change entry got (`agentPolicyRevision`). */
export const SetAgentPolicyResponse = z.object({ policy: AgentPolicy, workspaceVersion: Version });
export type SetAgentPolicyResponse = z.infer<typeof SetAgentPolicyResponse>;

/**
 * What `effectiveMode` reads: the default, the overrides and, for an agent, the folders above its
 * scope (`ancestors`). Pass a full policy (a server, the web app) or the `rules` that
 * `resolveAgentPolicyView` returned, never an agent's raw view: rules that still hold
 * `otherFolderHashes` read as `review`.
 */
export interface AgentPolicyRules {
  readonly default: AgentWriteMode;
  readonly folders: readonly AgentPolicyFolder[];
  readonly ancestors?:
    readonly { readonly folderId: string; readonly ancestorIds: readonly string[] }[] | undefined;
  readonly otherFolderHashes?: readonly string[] | undefined;
}

/** One folder of a note's ancestry: the folder itself, then its parent, up to the top level. */
export interface AgentPolicyAncestor {
  readonly folderId: string;
  /** A deleted folder can't sit above a live note, so it reads as `review`. */
  readonly deleted?: boolean | undefined;
  /**
   * The caller doesn't know this folder (above an agent's scope, or a cycle): the chain is cut
   * here, and continues only through the `ancestors` of the folder before it.
   */
  readonly unknown?: boolean | undefined;
}

/**
 * The mode for a note in the folder `ancestry[0]`: `ancestry` is the folder, then its parent, and
 * so on up to a top-level folder (`agentPolicyAncestry` builds it). The nearest folder with an
 * override wins, otherwise the default applies; a missing policy reads as direct. It fails closed:
 * an empty ancestry, a deleted folder in it, raw `otherFolderHashes`, or a cut-off chain without
 * the matching `ancestors` all read as `review`.
 */
export function effectiveMode(
  policy: AgentPolicyRules | null | undefined,
  ancestry: readonly AgentPolicyAncestor[],
): AgentWriteMode {
  const rules: AgentPolicyRules = policy ?? missingAgentPolicy();
  if ((rules.otherFolderHashes?.length ?? 0) > 0 || ancestry.length === 0) return "review";
  const overrides = new Map<string, AgentWriteMode>(
    rules.folders.map((folder) => [folder.folderId, folder.mode]),
  );
  const chains = new Map<string, readonly string[]>(
    (rules.ancestors ?? []).map((entry) => [entry.folderId, entry.ancestorIds]),
  );
  let previous: string | undefined;
  for (const folder of ancestry) {
    if (folder.unknown === true) {
      const chain = previous === undefined ? undefined : chains.get(previous);
      if (chain?.[0] !== folder.folderId) return "review";
      for (const id of chain) {
        const mode = overrides.get(id);
        if (mode !== undefined) return mode;
      }
      return rules.default;
    }
    if (folder.deleted === true) return "review";
    const own = overrides.get(folder.folderId);
    if (own !== undefined) return own;
    previous = folder.folderId;
  }
  return rules.default;
}

/** A folder as `agentPolicyAncestry` needs it: its parent (null at the top) and whether deleted. */
export interface AgentPolicyFolderInfo {
  readonly parentId: string | null;
  readonly deleted: boolean;
}

/** Looks a folder up by id; undefined when the caller doesn't know it. */
export type AgentPolicyFolderLookup = (folderId: string) => AgentPolicyFolderInfo | undefined;

/**
 * A folder's ancestry for `effectiveMode`, the folder first: it follows `parentId` to a top-level
 * folder. A folder `lookup` doesn't know (an agent can't see above its scope) or a cycle ends it
 * with an `unknown` entry.
 */
export function agentPolicyAncestry(
  folderId: string,
  lookup: AgentPolicyFolderLookup,
): AgentPolicyAncestor[] {
  const ancestry: AgentPolicyAncestor[] = [];
  const seen = new Set<string>();
  for (let id: string | null = folderId; id !== null;) {
    const folder: AgentPolicyFolderInfo | undefined = seen.has(id) ? undefined : lookup(id);
    if (folder === undefined) {
      ancestry.push({ folderId: id, unknown: true });
      break;
    }
    seen.add(id);
    ancestry.push({ folderId: id, deleted: folder.deleted });
    id = folder.parentId;
  }
  return ancestry;
}

/**
 * An agent's view of a policy (what `getAgentPolicy` answers an agent, built the same way by the
 * server and the web app): the overrides on its folders and below in `folders`, the hash of every
 * other in `otherFolderHashes`, and each token folder's ancestors. `scopeFolderIds` empty is a
 * whole-workspace token, which sees every override. `lookup` must know the whole folder tree.
 */
export async function agentPolicyViewFor(
  policy: AgentPolicy,
  scopeFolderIds: readonly string[],
  lookup: AgentPolicyFolderLookup,
): Promise<AgentPolicy> {
  const full = {
    default: policy.default,
    folders: policy.folders,
    revision: policy.revision,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    signed: policy.signed,
  };
  if (scopeFolderIds.length === 0) return { ...full, otherFolderHashes: [], ancestors: [] };
  const scope = new Set(scopeFolderIds);
  const inScope = (folderId: string) =>
    agentPolicyAncestry(folderId, lookup).some(
      (folder) => folder.unknown !== true && scope.has(folder.folderId),
    );
  const visible = full.folders.filter((folder) => inScope(folder.folderId));
  const hidden = full.folders.filter((folder) => !inScope(folder.folderId));
  return {
    ...full,
    folders: visible,
    otherFolderHashes: await Promise.all(hidden.map(agentPolicyFolderHash)),
    ancestors: [...scope].map((folderId) => ({
      folderId: folderId as FolderId,
      ancestorIds: agentPolicyAncestry(folderId, lookup)
        .slice(1)
        .map((folder) => folder.folderId as FolderId),
    })),
  };
}

/** Why `resolveAgentPolicyView` refused a view; the caller then treats every folder as `review`. */
export type AgentPolicyViewProblem =
  /** The view doesn't parse (a duplicate, a malformed hash, a mismatched revision). */
  | "malformed"
  /** The revision is below the floor (the agent_key's `policyRevision`, the pinned high mark). */
  | "below_floor"
  /** No signature, yet not the empty revision-0 policy. */
  | "unsigned"
  /** Signed for another workspace. */
  | "wrong_workspace"
  /** Signed by another account than the workspace owner's. */
  | "wrong_account"
  /** An `ancestors` entry for a folder that isn't one of the token's folders. */
  | "unexpected_ancestors"
  /** The signed hash isn't the hash of what the view holds. */
  | "hash_mismatch"
  /** The owner's signature doesn't verify. */
  | "bad_signature"
  /** A visible folder's override is among the hidden hashes. */
  | "hidden_override"
  /** An ancestor has both a `direct` and a `review` hash. */
  | "conflicting_override"
  /**
   * Never from `resolveAgentPolicyView` itself: the caller's pin refused it (knowtarium/client's
   * `TrustState`). It verifies, but the owner signed another policy at this revision, which this
   * device saw first: a server got the owner to sign twice at one revision (a fork).
   */
  | "equivocation";

export type AgentPolicyViewResult =
  | {
      readonly ok: true;
      readonly revision: number;
      /** What an `agent_edited` signs as `policySha256` (with `revision`). */
      readonly policySha256: string;
      /** For `effectiveMode`: the visible overrides plus the ancestors' derived ones. */
      readonly rules: AgentPolicyRules;
    }
  | { readonly ok: false; readonly problem: AgentPolicyViewProblem };

export interface ResolveAgentPolicyViewOptions {
  /** The workspace the caller asked about. */
  readonly workspaceId: string;
  /** The workspace owner's account id, from a source the server can't swap (the pinned owner). */
  readonly ownerAccountId: string;
  /** Every folder the caller sees (its scope's folders, or all of them): none may hide. */
  readonly visibleFolderIds: Iterable<string>;
  /**
   * The token's folders, when the caller knows them (an agent: its token's `folderIds`; empty for
   * a whole-workspace token). Then an `ancestors` entry for any other folder is refused.
   */
  readonly scopeFolderIds?: readonly string[] | undefined;
  /**
   * The lowest revision accepted: the `policyRevision` of the agent's verified `agent_key`, or the
   * highest revision the caller has seen, whichever is higher. 0 when absent; anything but a
   * safe integer of 0 or more throws, so a bad value can't switch the floor off.
   */
  readonly minRevision?: number | undefined;
  /**
   * Checks the owner's signature on `agent_policy`. Use `agentPolicySignatureVerifier` from
   * knowtarium/client (crypto's `verifyEnvelopeFor` with the pinned owner key), never a stub.
   */
  readonly verifySignature: (signed: SignedAgentPolicy) => boolean | Promise<boolean>;
}

/**
 * Checks a policy as read from the server (an agent's view, or a full policy: one with no hidden
 * hashes) and returns the rules to pass `effectiveMode`, or the problem. The one check the CLI,
 * the web app and the sync API share (see the top of this file).
 */
export async function resolveAgentPolicyView(
  view: AgentPolicy,
  options: ResolveAgentPolicyViewOptions,
): Promise<AgentPolicyViewResult> {
  const minRevision = options.minRevision ?? 0;
  if (!Number.isSafeInteger(minRevision) || minRevision < 0) {
    throw new TypeError("resolveAgentPolicyView: minRevision must be a safe integer of 0 or more");
  }
  const refuse = (problem: AgentPolicyViewProblem) => ({ ok: false, problem }) as const;
  if (!AgentPolicy.safeParse(view).success) return refuse("malformed");
  if (view.revision < minRevision) return refuse("below_floor");
  const hashes = view.otherFolderHashes ?? [];
  let policySha256: string;
  try {
    policySha256 = await agentPolicySha256({ ...view, otherFolderHashes: hashes });
  } catch (error) {
    if (error instanceof TypeError) return refuse("malformed");
    throw error;
  }
  if (view.signed === null) {
    if (policySha256 !== MISSING_AGENT_POLICY_SHA256) return refuse("unsigned");
  } else {
    if (view.signed.envelope.workspaceId !== options.workspaceId) return refuse("wrong_workspace");
    if (view.signed.envelope.accountId !== options.ownerAccountId) return refuse("wrong_account");
    if (view.signed.envelope.policySha256 !== policySha256) return refuse("hash_mismatch");
    if (!(await options.verifySignature(view.signed))) return refuse("bad_signature");
  }

  if (options.scopeFolderIds !== undefined) {
    const scope = new Set(options.scopeFolderIds);
    if ((view.ancestors ?? []).some((entry) => !scope.has(entry.folderId))) {
      return refuse("unexpected_ancestors");
    }
  }
  const rules = (derived: ReadonlyMap<string, AgentWriteMode>) =>
    ({
      ok: true,
      revision: view.revision,
      policySha256,
      rules: {
        default: view.default,
        folders: [
          ...view.folders,
          ...[...derived].map(([folderId, mode]) => ({ folderId: folderId as FolderId, mode })),
        ],
        ancestors: view.ancestors ?? [],
      },
    }) as const;
  // nothing hidden: no override can hide, and every ancestor's override (if any) is in `folders`
  if (hashes.length === 0) return rules(new Map());

  const hidden = new Set(hashes);
  const hashesOf = async (folderId: string) =>
    Promise.all(
      AgentWriteMode.options.map(
        async (mode) =>
          [mode, await agentPolicyFolderHash({ folderId, mode } as AgentPolicyFolder)] as const,
      ),
    );
  for (const folderId of options.visibleFolderIds) {
    if ((await hashesOf(folderId)).some(([, hash]) => hidden.has(hash))) {
      return refuse("hidden_override");
    }
  }
  const shown = new Set(view.folders.map((folder) => folder.folderId as string));
  const derived = new Map<string, AgentWriteMode>();
  for (const entry of view.ancestors ?? []) {
    for (const folderId of entry.ancestorIds) {
      if (shown.has(folderId) || derived.has(folderId)) continue;
      const modes = (await hashesOf(folderId)).filter(([, hash]) => hidden.has(hash));
      if (modes.length > 1) return refuse("conflicting_override");
      const found = modes[0];
      if (found !== undefined) derived.set(folderId, found[0]);
    }
  }
  return rules(derived);
}

/** Domain tag of a policy hash (`agentPolicySha256`). */
export const AGENT_POLICY_HASH_TAG = "knowtarium-agent-policy-v1\n";

/** Domain tag of one override's hash (`agentPolicyFolderHash`). */
export const AGENT_POLICY_FOLDER_HASH_TAG = "knowtarium-agent-policy-folder-v1\n";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * The text an override's hash covers: the tag, then canonical JSON of `{folderId, mode}`. Throws a
 * `TypeError` for an unknown mode or a folder id with no canonical form.
 */
export function agentPolicyFolderText(folder: AgentPolicyFolder): string {
  if (!AgentWriteMode.safeParse(folder.mode).success) {
    throw new TypeError("agentPolicyFolderText: unknown mode");
  }
  return (
    AGENT_POLICY_FOLDER_HASH_TAG + canonicalJson({ folderId: folder.folderId, mode: folder.mode })
  );
}

/**
 * The text a policy hash covers: the tag, then the canonical JSON (RFC 8785) of
 * `{"default": mode, "folders": [every override's hash, sorted]}`. Throws a `TypeError` for an
 * unknown mode, a malformed hash or the same override twice.
 */
export function agentPolicyText(mode: AgentWriteMode, folderHashes: readonly string[]): string {
  if (!AgentWriteMode.safeParse(mode).success) {
    throw new TypeError("agentPolicyText: unknown mode");
  }
  if (!folderHashes.every((hash) => HEX_SHA256.test(hash))) {
    throw new TypeError("agentPolicyText: expected lowercase hex SHA-256 hashes");
  }
  const sorted = [...folderHashes].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new TypeError("agentPolicyText: the same override twice");
  }
  const list = sorted.map((hash) => JSON.stringify(hash)).join(",");
  return `${AGENT_POLICY_HASH_TAG}{"default":${JSON.stringify(mode)},"folders":[${list}]}`;
}

/**
 * SHA-256 of `agentPolicyFolderText(folder)`, as 64 lowercase hex characters. Throws what
 * `agentPolicyFolderText` throws, and a `TypeError` for a folder id that isn't ASCII.
 */
export async function agentPolicyFolderHash(folder: AgentPolicyFolder): Promise<string> {
  return sha256Hex(agentPolicyFolderText(folder));
}

/**
 * The `policySha256` an `agent_policy` (and an `agent_edited`) signs: SHA-256 of
 * `agentPolicyText` over the default and the hash of every override (`folders`, plus
 * `otherFolderHashes` for an agent's view), as 64 lowercase hex characters. Hashing each override
 * first lets an agent check the owner's signature without seeing the overrides outside its scope.
 * Order doesn't matter. Uses Web Crypto (`crypto.subtle`), as browsers, Node and Workers all have
 * it. Throws a `TypeError` for an unknown mode, a malformed or repeated hash (an override listed
 * both in `folders` and in `otherFolderHashes` too) or a folder id that isn't ASCII, and an
 * `Error` where Web Crypto is missing.
 */
export async function agentPolicySha256(rules: {
  readonly default: AgentWriteMode;
  readonly folders: readonly AgentPolicyFolder[];
  readonly otherFolderHashes?: readonly string[] | undefined;
}): Promise<string> {
  const own = await Promise.all(rules.folders.map(agentPolicyFolderHash));
  return sha256Hex(agentPolicyText(rules.default, [...own, ...(rules.otherFolderHashes ?? [])]));
}

// no DOM or Node types in the library: the one Web API this needs, typed here
interface WebCrypto {
  crypto?: { subtle?: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> } };
}

/** SHA-256 of ASCII text (the hash inputs above are all ASCII), as lowercase hex. */
async function sha256Hex(text: string): Promise<string> {
  const subtle = (globalThis as WebCrypto).crypto?.subtle;
  if (subtle === undefined) throw new Error("Web Crypto (crypto.subtle) is not available");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new TypeError("agent policy hash input must be ASCII");
    bytes[i] = code;
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const agentPolicyRoutes = {
  getAgentPolicy: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId/agent-policy",
    auth: "any",
    summary:
      "The workspace's agent policy, current or an old revision (for an agent, its view of it)",
    query: AgentPolicyQuery,
    response: AgentPolicyResponse,
  }),
  setAgentPolicy: defineRoute({
    method: "PUT",
    path: "/workspaces/:workspaceId/agent-policy",
    auth: "session",
    summary: "The owner replaces the agent policy, signed, if the base revision is still current",
    body: SetAgentPolicyRequest,
    response: SetAgentPolicyResponse,
  }),
};
