import type { Confirmation } from "./confirmations.js";
import {
  type AgentKeyRecord,
  EVENTS_PAGE_MAX,
  type TokenRevocation,
  type FolderId,
  type NoteEvent,
  type NoteId,
  type NoteMeta,
  routes,
} from "../../protocol/index.js";
import {
  isSyncApiError,
  isVersionPruned,
  VaultError,
  VersionPrunedError,
} from "../errors/index.js";
import {
  agentWriteOf,
  decryptNote,
  findDeleteEvent,
  findVersionEvent,
  isVersionWrite,
  type VerifiedAgentKey,
  verifyNoteDeletion,
  verifyNoteVersion,
} from "../vault/index.js";
import { agentKeysFor, anyRevoked } from "./agent-keys.js";
import { type SyncContext, withKeys } from "./context.js";
import type { NoteSnapshot } from "./events.js";
import { pageBySeq } from "./paging.js";

/** A verified note version with the envelope and signed event it came with, for the cache. */
export interface VerifiedNote extends Omit<
  NoteSnapshot,
  "signedWrite" | "agentWrite" | "confirmations"
> {
  readonly ciphertext?: Uint8Array;
  readonly event: NoteEvent;
  /**
   * For an agent's version (`agent_edited`): the owner-vouched keys of its token, which the
   * version verified under (kept with it in the cache, and flagging a revoked agent).
   */
  readonly agentKeys?: readonly VerifiedAgentKey[];
}

/**
 * History events after `since`, for one note or the whole scope, page by page; with `until`, it
 * stops once it has every event up to that workspace version.
 */
export function fetchEvents(
  context: SyncContext,
  query: { readonly since?: number; readonly until?: number; readonly noteId?: NoteId },
): Promise<NoteEvent[]> {
  return pageBySeq(
    "GET /workspaces/:workspaceId/events",
    async (since) => {
      const { data } = await context.api.call(routes.listEvents, {
        params: { workspaceId: context.workspaceId },
        query: {
          ...(query.noteId === undefined ? {} : { noteId: query.noteId }),
          ...(since === undefined ? {} : { since }),
          limit: EVENTS_PAGE_MAX,
        },
      });
      return { items: data.events, hasMore: data.hasMore };
    },
    { since: query.since, until: query.until },
  );
}

/**
 * Downloads, verifies and decrypts one version of a note. The version must come with the
 * person's signed event over exactly its bytes (looked up in `events`, else fetched for the
 * note); a delete marker with its signed `deleted` event. Without `folderId` (an old version,
 * whose folder may differ from today's), the folder comes from the signed envelope. Throws
 * `VersionPrunedError` for a version whose content was removed after the history period.
 */
export async function readNoteVersion(
  context: SyncContext,
  details: {
    readonly noteId: NoteId;
    readonly folderId?: FolderId;
    readonly version: number;
    readonly deleted?: boolean;
    readonly events?: readonly NoteEvent[];
    /** When version 1 was stored, if the caller knows (the feed and `getNote` say). */
    readonly createdAt?: string;
    /** The version's envelope, already fetched in a batch (`getVersions`); verified the same way. */
    readonly ciphertext?: Uint8Array;
  },
): Promise<VerifiedNote> {
  const { noteId, folderId, version } = details;
  const createdAt = details.createdAt ?? null;
  const workspaceId = context.workspaceId;
  const eventFor = async (
    find: (events: readonly NoteEvent[]) => NoteEvent | undefined,
  ): Promise<NoteEvent | undefined> =>
    find(details.events ?? []) ?? find(await fetchEvents(context, { noteId }));

  if (details.deleted === true) {
    const found = await eventFor((events) => findDeleteEvent(events, noteId, version));
    const event = verifyNoteDeletion({
      workspaceId,
      noteId,
      version,
      event: found,
      signer: context.verifier.owner,
    });
    const folder = folderId ?? (await currentFolder(context, noteId));
    return { noteId, folderId: folder, version, name: null, text: null, createdAt, event };
  }
  let ciphertext = details.ciphertext;
  if (ciphertext === undefined) {
    const result = await context.api
      .call(routes.getVersion, { params: { workspaceId, noteId, version } })
      .catch((error: unknown) => {
        // 410: the content was removed after the history period, not a failure to retry
        throw isSyncApiError(error, "expired") ? new VersionPrunedError(noteId, version) : error;
      });
    if (result.version !== version) {
      throw new VaultError("version_mismatch", "the server sent another version than asked for");
    }
    ciphertext = result.data;
  }
  const found = await eventFor((events) => findVersionEvent(events, noteId, version));
  const agentKeys = await agentKeysFor(context.verifier, found);
  const event = verifyNoteVersion({
    workspaceId,
    noteId,
    version,
    ciphertext,
    ...(folderId === undefined ? {} : { folderId }),
    event: found,
    signer: context.verifier.owner,
    agentKeys,
  });
  const { name, text } = await withKeys(context, (keys) =>
    decryptNote(keys, { workspaceId, noteId }, ciphertext),
  );
  const fields = event.signed?.envelope;
  const folder =
    folderId ??
    (fields !== undefined && isVersionWrite(fields.type) && "folderId" in fields
      ? fields.folderId
      : await currentFolder(context, noteId));
  return {
    noteId,
    folderId: folder,
    version,
    name,
    text,
    createdAt,
    ciphertext,
    event,
    ...(fields?.type === "agent_edited" ? { agentKeys } : {}),
  };
}

/**
 * Checks what the server says it stored for this client's own write: exactly the next version,
 * in the folder sent, recorded with a signed event over exactly the bytes sent. Throws
 * `version_mismatch` or a signature error before any rollback mark moves.
 */
export function checkStoredWrite(
  context: SyncContext,
  stored: { readonly note: NoteMeta; readonly event: NoteEvent },
  sent: {
    readonly noteId: NoteId;
    readonly folderId?: FolderId;
    readonly baseVersion: number;
    /** The uploaded envelope; absent for a delete. */
    readonly ciphertext?: Uint8Array;
  },
  /** For an agent's own direct write: its own verified key, which must have signed it. */
  agentKeys?: readonly VerifiedAgentKey[],
): void {
  const version = sent.baseVersion + 1;
  const { note } = stored;
  const deleted = sent.ciphertext === undefined;
  if (
    note.id !== sent.noteId ||
    note.currentVersion !== version ||
    note.deleted !== deleted ||
    (sent.folderId !== undefined && note.folderId !== sent.folderId)
  ) {
    throw new VaultError("version_mismatch", "the server stored something else than was sent");
  }
  const common = {
    workspaceId: context.workspaceId,
    noteId: sent.noteId,
    version,
    event: stored.event,
    signer: context.verifier.owner,
  };
  const signedType = stored.event.signed?.envelope.type;
  // a person's write must come back as a person's, an agent's as its own `agent_edited`
  if ((agentKeys !== undefined) !== (signedType === "agent_edited")) {
    throw new VaultError("untrusted_signature", "the stored write carries another signature");
  }
  if (sent.ciphertext === undefined) verifyNoteDeletion(common);
  else {
    verifyNoteVersion({
      ...common,
      ciphertext: sent.ciphertext,
      folderId: note.folderId,
      ...(agentKeys === undefined ? {} : { agentKeys }),
    });
  }
}

async function currentFolder(context: SyncContext, noteId: NoteId): Promise<FolderId> {
  const { data } = await context.api.call(routes.getNote, {
    params: { workspaceId: context.workspaceId, noteId },
  });
  return data.note.folderId;
}

/** A note without its envelope and event, with the confirmations known up to its version. */
export function snapshotOf(
  note: VerifiedNote,
  confirmations: readonly Confirmation[] = [],
): NoteSnapshot {
  return {
    noteId: note.noteId,
    folderId: note.folderId,
    version: note.version,
    name: note.name,
    text: note.text,
    createdAt: note.createdAt,
    signedWrite: signedWriteOf(note.event),
    agentWrite: agentWriteOf(note.event, anyRevoked(note.agentKeys ?? [])),
    confirmations,
  };
}

/**
 * Verified agent keys as the cache keeps them: each `agent_key` record once (by signature), and
 * the signed revocations they verified with.
 */
export function cachedKeys(keys: readonly VerifiedAgentKey[]): {
  agentKeys: AgentKeyRecord[];
  agentRevocations: TokenRevocation[];
} {
  const seen = new Set<string>();
  const agentKeys: AgentKeyRecord[] = [];
  const agentRevocations: TokenRevocation[] = [];
  for (const key of keys) {
    if (seen.has(key.signed.signature)) continue;
    seen.add(key.signed.signature);
    agentKeys.push({ signed: key.signed, revokedAt: key.revokedAt });
    if (key.revocation !== null) {
      agentRevocations.push({
        workspaceId: key.signed.envelope.workspaceId,
        tokenId: key.signed.envelope.tokenId,
        signed: key.revocation,
      });
    }
  }
  return { agentKeys, agentRevocations };
}

/** The person's signed `edited` or `approved` write in a verified version's event, if any. */
export function signedWriteOf(event: NoteEvent | undefined): NoteSnapshot["signedWrite"] {
  const fields = event?.signed?.envelope;
  if (fields === undefined || (fields.type !== "edited" && fields.type !== "approved")) return null;
  return { by: fields.accountId, at: fields.createdAt };
}

/**
 * Makes a verified version the note's current one: refuses a version below the highest seen
 * (`rollback`), caches the envelope with its signed event, releases the note from quarantine and
 * reports it.
 */
export async function acceptNote(context: SyncContext, note: VerifiedNote): Promise<NoteSnapshot> {
  await context.trust.acceptNoteVersion(context.workspaceId, note.noteId, note.version);
  context.confirmations.add(note.noteId, note.event.signed);
  // an agent's version keeps its vouched keys beside it, so it verifies again offline
  const keys = cachedKeys(note.agentKeys ?? []);
  await context.cache?.putNote({
    workspaceId: context.workspaceId,
    noteId: note.noteId,
    folderId: note.folderId,
    version: note.version,
    deleted: note.text === null,
    ...(note.createdAt === null ? {} : { createdAt: note.createdAt }),
    event: note.event,
    ...(note.ciphertext === undefined ? {} : { ciphertext: note.ciphertext }),
    writes: context.confirmations.signedFor(note.noteId),
    ...(keys.agentKeys.length === 0 ? {} : keys),
  });
  await context.quarantine.release(note.noteId);
  const snapshot = snapshotOf(
    note,
    context.confirmations.confirmationsOf(note.noteId, note.version, note.event),
  );
  context.emitter.emit({ type: "note", note: snapshot });
  return snapshot;
}

/**
 * The current version of a note, verified and decrypted, and accepted as current. A note's current
 * version is never removed after the history period, so a server that says it was (410) throws
 * `version_mismatch`, an integrity error that quarantines the note, never a `VersionPrunedError`.
 * With `newerThan` (a version the server said was removed, so a later one must have replaced it),
 * a current version at or below it throws `version_mismatch` too, before anything is accepted.
 */
export async function readCurrentNote(
  context: SyncContext,
  noteId: NoteId,
  options: { readonly newerThan?: number } = {},
): Promise<NoteSnapshot> {
  const { data } = await context.api.call(routes.getNote, {
    params: { workspaceId: context.workspaceId, noteId },
  });
  if (options.newerThan !== undefined && data.note.currentVersion <= options.newerThan) {
    throw new VaultError("version_mismatch", "the server removed a version nothing replaced");
  }
  const note = await readCurrentVersion(context, {
    noteId,
    folderId: data.note.folderId,
    version: data.note.currentVersion,
    deleted: data.note.deleted,
    createdAt: data.note.createdAt,
  });
  return acceptNote(context, note);
}

/**
 * `readNoteVersion` for the version the server says is the note's current one. A current version
 * is never removed after the history period, so a 410 for it throws `version_mismatch` (an
 * integrity error that quarantines the note), never a `VersionPrunedError`.
 */
export async function readCurrentVersion(
  context: SyncContext,
  details: Parameters<typeof readNoteVersion>[1],
): Promise<VerifiedNote> {
  return readNoteVersion(context, details).catch((error: unknown) => {
    if (!isVersionPruned(error)) throw error;
    throw new VaultError("version_mismatch", "the server removed the note's current version");
  });
}
