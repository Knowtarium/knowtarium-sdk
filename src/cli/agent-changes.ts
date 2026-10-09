import { fromBase64Url } from "../crypto/index.js";
import { type AgentPolicyRules, type AgentWriteMode, effectiveMode } from "../protocol/index.js";
import {
  createApiClient,
  type FetchLike,
  fetchAgentPolicy,
  type TrustState,
} from "../client/index.js";
import { type Connection, writesDirectly } from "./storage/credentials.js";

/**
 * How a connection's agent changes notes, for `connect` and `status`:
 *
 * - `writes`: `none` (a read-only token), `revoked`, `propose` (no signing key the owner vouched
 *   for: a connection made before direct writes, or a web app that didn't vouch), `direct`
 *   (written directly where the workspace allows it, proposed elsewhere) or `unknown` (offline,
 *   from the saved summary alone);
 * - `default`: the mode at the token's folders (the workspace default for a whole-workspace
 *   token; `mixed` when its folders differ), by the policy as this agent sees it, checked against
 *   the pinned owner key and the floor; null when it couldn't be read or checked;
 * - `reviewFolders` and `directFolders`: how many of the token's folders and the overrides this
 *   agent sees ask for approval, or let changes apply.
 */
export interface AgentChanges {
  readonly writes: "none" | "revoked" | "propose" | "direct" | "unknown";
  readonly default: AgentWriteMode | "mixed" | null;
  readonly reviewFolders: number | null;
  readonly directFolders: number | null;
}

/** Changes with no policy known (offline, revoked, read only, or a policy that didn't check). */
export function agentChangesWithout(writes: AgentChanges["writes"]): AgentChanges {
  return { writes, default: null, reviewFolders: null, directFolders: null };
}

/** The mode at one of the token's folders: its own override, else the chain above it. */
function tokenFolderMode(rules: AgentPolicyRules, folderId: string): AgentWriteMode {
  const above = rules.ancestors?.find((entry) => entry.folderId === folderId)?.ancestorIds[0];
  return effectiveMode(rules, [
    { folderId },
    ...(above === undefined ? [] : [{ folderId: above, unknown: true }]),
  ]);
}

/**
 * Reads the policy with the connection's token and checks it (the owner key pinned at connect,
 * the `agent_key` floor, the device's own floor). Never throws: what can't be read is null.
 */
export async function readAgentChanges(
  connection: Connection,
  deps: { readonly fetch: FetchLike; readonly trust: TrustState; readonly timeoutMs?: number },
): Promise<AgentChanges> {
  const writes =
    connection.access === "read" ? "none" : writesDirectly(connection) ? "direct" : "propose";
  if (writes === "none") return agentChangesWithout(writes);
  try {
    const api = createApiClient({
      baseUrl: connection.apiUrl,
      fetch: deps.fetch,
      auth: { kind: "agent", token: connection.tokenSecret },
      retry: { maxAttempts: 1 },
      timeoutMs: deps.timeoutMs ?? 10_000,
    });
    const owner =
      (await deps.trust.ownerKey(connection.workspaceId)) ??
      fromBase64Url(connection.ownerSignPublicKey);
    const { resolved } = await fetchAgentPolicy(api, {
      workspaceId: connection.workspaceId,
      ownerSigningPublicKey: owner,
      ownerAccountId: connection.ownerId,
      trust: deps.trust,
      scopeFolderIds: connection.folderIds,
      view: true,
      visibleFolderIds: connection.folderIds,
      minRevision: connection.agentKey?.envelope.policyRevision ?? 0,
    });
    if (!resolved.ok) return agentChangesWithout(writes);
    const { rules } = resolved;
    const scoped = connection.folderIds.length > 0;
    const base = scoped
      ? connection.folderIds.map((folderId) => tokenFolderMode(rules, folderId))
      : [rules.default];
    const modes = [...(scoped ? base : []), ...rules.folders.map((folder) => folder.mode)];
    const [first] = base;
    return {
      writes,
      default: first !== undefined && base.every((mode) => mode === first) ? first : "mixed",
      reviewFolders: modes.filter((mode) => mode === "review").length,
      directFolders: modes.filter((mode) => mode === "direct").length,
    };
  } catch {
    return agentChangesWithout(writes);
  }
}

/** A few words for the terminal: `read and write`, `read only`, and so on. */
export function describeAgentChanges(changes: AgentChanges): string {
  switch (changes.writes) {
    case "none":
      return "read only";
    case "revoked":
      return "none (this agent's access was revoked)";
    case "unknown":
      return "unknown offline (`knowtarium status` online shows it)";
    case "propose":
      return "read, and propose changes for approval";
    case "direct": {
      const { default: mode, reviewFolders, directFolders } = changes;
      if (mode === null) return "read and write where the workspace allows it";
      if (mode === "direct" && (reviewFolders ?? 0) === 0) return "read and write";
      if (mode === "review" && (directFolders ?? 0) === 0) return "read; changes need approval";
      return mode === "direct"
        ? "read and write; changes need approval in some folders"
        : "read and write in some folders; elsewhere changes need approval";
    }
  }
}
