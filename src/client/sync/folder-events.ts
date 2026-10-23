import { ciphertextSha256, fromBase64Url, verifyEnvelopeFor } from "../../crypto/index.js";
import {
  FOLDER_EVENTS_PAGE_MAX,
  type FolderEvent,
  type FolderEventAction,
  type FolderId,
  routes,
  type SignedAction,
} from "../../protocol/index.js";
import {
  checkAgentSigned,
  decryptFolderName,
  toSignedEnvelope,
  type TrustedSigner,
  type VerifiedAgentKey,
} from "../vault/index.js";
import { agentKeysFor, anyRevoked } from "./agent-keys.js";
import { type SyncContext, withKeys } from "./context.js";
import { pageBySeq } from "./paging.js";

/*
 * The folder history feed (protocol 3): one row per folder change, people's and agents', with
 * who made it and the parent and encrypted name before and after, for showing and undoing it.
 * Signed rows (a person's `folder_created` or `folder_moved`, an agent's `agent_folder_*`) are
 * verified here against the row; a person's rename or delete is unsigned, the server's word.
 */

/** One folder event, verified and with its names decrypted. */
export interface FolderEventEntry {
  readonly event: FolderEvent;
  /**
   * `verified`: its signature verifies and matches the row; `unsigned`: a person's rename or
   * delete, which carries none (the server's word); `invalid`: anything else (a signature that
   * fails or names something else, or a change that should be signed and isn't).
   */
  readonly signature: "verified" | "unsigned" | "invalid";
  /** For an agent's change that verified: its token, and whether it was revoked since. */
  readonly agent: { readonly tokenId: string; readonly revoked: boolean } | null;
  /** The folder's name before and after (null where there is none, or it can't be read). */
  readonly nameBefore: string | null;
  readonly nameAfter: string | null;
}

/** The envelope type a row of `action` must carry: a person's (null: unsigned) or an agent's. */
function expectedType(action: FolderEventAction, byAgent: boolean): SignedAction | null {
  switch (action) {
    case "created":
    case "restored":
      return byAgent ? "agent_folder_created" : "folder_created";
    case "moved":
      return byAgent ? "agent_folder_moved" : "folder_moved";
    case "renamed":
      return byAgent ? "agent_folder_renamed" : null;
    case "deleted":
      return byAgent ? "agent_folder_deleted" : null;
  }
}

/**
 * How far to trust a folder event: its envelope must be the type its action and author call for,
 * name this folder (and for a create or move its new parent, for an agent's move the parent it
 * left and for an agent's rename or delete its parent, for a create or rename the hash of its new
 * encrypted name), and verify under the owner's key (a person's) or the agent's vouched key for
 * the token the row names (an agent's).
 */
function folderEventSignature(
  event: FolderEvent,
  workspaceId: string,
  owner: TrustedSigner,
  agentKeys: readonly VerifiedAgentKey[] = [],
): FolderEventEntry["signature"] {
  const byAgent = event.authorTokenId !== null;
  const type = expectedType(event.action, byAgent);
  const signed = event.signed;
  if (type === null) return signed === null ? "unsigned" : "invalid";
  if (signed?.envelope.type !== type) return "invalid";
  const fields = signed.envelope as unknown as Record<string, unknown>;
  if (fields["folderId"] !== event.folderId) return "invalid";
  if (
    (event.action === "created" || event.action === "restored" || event.action === "moved") &&
    (fields["parentId"] ?? null) !== event.parentAfter
  ) {
    return "invalid";
  }
  // an agent signs the parents too (protocol 3): the parent it left, the parent it renamed or
  // deleted the folder under
  if (
    byAgent &&
    event.action === "moved" &&
    (fields["fromParentId"] ?? null) !== event.parentBefore
  ) {
    return "invalid";
  }
  if (
    byAgent &&
    (event.action === "renamed" || event.action === "deleted") &&
    (fields["parentId"] ?? null) !== event.parentBefore
  ) {
    return "invalid";
  }
  if (event.action === "created" || event.action === "restored" || event.action === "renamed") {
    if (event.encNameAfter === null) return "invalid";
    if (fields["ciphertextSha256"] !== ciphertextSha256(fromBase64Url(event.encNameAfter))) {
      return "invalid";
    }
  }
  const account = owner.accountId === undefined ? {} : { accountId: owner.accountId };
  if (byAgent) {
    if (fields["tokenId"] !== event.authorTokenId) return "invalid";
    const ok = agentKeys.some(
      (key) =>
        checkAgentSigned(signed, key, { workspaceId, folderId: event.folderId, ...account }).ok,
    );
    return ok ? "verified" : "invalid";
  }
  const ok = verifyEnvelopeFor(toSignedEnvelope(signed), owner.publicKey, {
    type,
    workspaceId,
    folderId: event.folderId,
    ...account,
  });
  return ok ? "verified" : "invalid";
}

/** A folder event, verified and with its names decrypted. */
async function readFolderEvent(
  context: SyncContext,
  event: FolderEvent,
): Promise<FolderEventEntry> {
  const { workspaceId } = context;
  const agentKeys = await agentKeysFor(context.verifier, event);
  const signature = folderEventSignature(event, workspaceId, context.verifier.owner, agentKeys);
  const name = async (encName: string | null): Promise<string | null> => {
    if (encName === null) return null;
    try {
      return await withKeys(context, (keys) =>
        decryptFolderName(keys, { workspaceId, folderId: event.folderId }, encName),
      );
    } catch {
      return null;
    }
  };
  const fields = event.signed?.envelope;
  return {
    event,
    signature,
    agent:
      signature === "verified" && fields !== undefined && "tokenId" in fields
        ? { tokenId: fields.tokenId, revoked: anyRevoked(agentKeys) }
        : null,
    nameBefore: await name(event.encNameBefore),
    nameAfter: await name(event.encNameAfter),
  };
}

/**
 * The folder history (`listFolderEvents`) after `since`, for one folder or every folder in the
 * caller's scope, page by page, each verified (`folderEventSignature`) and with its names
 * decrypted.
 */
export async function fetchFolderEvents(
  context: SyncContext,
  query: { readonly since?: number; readonly folderId?: FolderId } = {},
): Promise<FolderEventEntry[]> {
  const events = await pageBySeq(
    "GET /workspaces/:workspaceId/folder-events",
    async (since) => {
      const { data } = await context.api.call(routes.listFolderEvents, {
        params: { workspaceId: context.workspaceId },
        query: {
          ...(query.folderId === undefined ? {} : { folderId: query.folderId }),
          ...(since === undefined ? {} : { since }),
          limit: FOLDER_EVENTS_PAGE_MAX,
        },
      });
      return { items: data.events, hasMore: data.hasMore };
    },
    { since: query.since, until: undefined },
  );
  return Promise.all(events.map((event) => readFolderEvent(context, event)));
}
