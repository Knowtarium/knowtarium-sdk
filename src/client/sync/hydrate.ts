import type { NoteContent } from "../../core/files/index.js";
import type { CachedNote } from "../cache/index.js";
import { VaultError } from "../errors/index.js";
import {
  decryptFolderName,
  decryptNote,
  decryptWorkspaceName,
  verifyNoteDeletion,
  verifyNoteVersion,
} from "../vault/index.js";
import { type SyncContext, withKeys } from "./context.js";
import { decryptAttachmentMeta } from "../attachments/meta.js";
import { attachmentSnapshot } from "./events.js";
import { agentWriteOf, type VerifiedAgentKey, verifiedAgentKeys } from "../vault/index.js";
import { agentKeysFor, anyRevoked } from "./agent-keys.js";
import { cachedKeys, signedWriteOf } from "./notes.js";
import { isIntegrityError } from "./quarantine.js";

/**
 * Checks a cached note like a downloaded one: its signed event must still verify over the cached
 * bytes (an agent's under its vouched key), and it may not be older than this device has seen.
 * Returns its text (null when deleted) and, for an agent's version, whether that agent was
 * revoked since.
 */
async function verifyCached(
  context: SyncContext,
  note: CachedNote,
  freshKeys?: readonly VerifiedAgentKey[],
): Promise<{ content: NoteContent | null; agentRevoked: boolean }> {
  const { workspaceId, trust } = context;
  if (note.version < (await trust.noteVersion(workspaceId, note.noteId))) {
    throw new VaultError("rollback", "the cached version is older than one seen");
  }
  const common = {
    workspaceId,
    noteId: note.noteId,
    version: note.version,
    event: note.event,
    signer: context.verifier.owner,
  };
  if (note.deleted) {
    verifyNoteDeletion(common);
    return { content: null, agentRevoked: false };
  }
  const ciphertext = note.ciphertext;
  if (ciphertext === undefined) throw new VaultError("missing_signature", "the cache lost a blob");
  const agentKeys = freshKeys ?? (await cachedAgentKeys(context, note));
  verifyNoteVersion({ ...common, ciphertext, folderId: note.folderId, agentKeys });
  const content = await withKeys(context, (keys) =>
    decryptNote(keys, { workspaceId, noteId: note.noteId }, ciphertext),
  );
  return { content, agentRevoked: anyRevoked(agentKeys) };
}

/**
 * The vouched keys an agent's cached version verifies under: the `agent_key` records cached with
 * it, checked again against the owner's key (no network, so the CLI loads offline); a cache from
 * before they were kept asks the server. Their revocation flag is as of caching; a fresh read
 * (`readNote`, `readHistory`) has the current one.
 */
async function cachedAgentKeys(
  context: SyncContext,
  note: CachedNote,
): Promise<readonly VerifiedAgentKey[]> {
  const fields = note.event?.signed?.envelope;
  if (fields?.type !== "agent_edited") return [];
  if (note.agentKeys === undefined) return agentKeysFor(context.verifier, note.event);
  const keys = verifiedAgentKeys(
    { agentKeys: [...note.agentKeys], revocations: [...(note.agentRevocations ?? [])] },
    context.verifier.owner,
    context.workspaceId,
  );
  return keys.get(fields.tokenId) ?? [];
}

async function hydrateNote(context: SyncContext, note: CachedNote): Promise<void> {
  const { workspaceId, trust } = context;
  let content: NoteContent | null;
  let agentRevoked: boolean;
  try {
    ({ content, agentRevoked } = await verifyCached(context, note));
  } catch (error) {
    if (!isIntegrityError(error)) throw error;
    // never shown as current; the next pull fetches the note again
    await context.quarantine.add(note.noteId, note.version, error);
    return;
  }
  await trust.acceptNoteVersion(workspaceId, note.noteId, note.version);
  // the signed writes kept with it, verified again before they count
  for (const signed of note.writes ?? []) context.confirmations.add(note.noteId, signed);
  context.confirmations.add(note.noteId, note.event?.signed);
  // the last verified version; if a newer one is quarantined, the quarantine event says so
  emitCached(context, note, content, agentRevoked);
}

/** Reports a cached note that verified. */
function emitCached(
  context: SyncContext,
  note: CachedNote,
  content: NoteContent | null,
  agentRevoked: boolean,
): void {
  context.emitter.emit({
    type: "note",
    note: {
      noteId: note.noteId,
      folderId: note.folderId,
      version: note.version,
      name: content?.name ?? null,
      text: content?.text ?? null,
      createdAt: note.createdAt ?? null,
      signedWrite: content === null ? null : signedWriteOf(note.event),
      agentWrite: content === null ? null : agentWriteOf(note.event, agentRevoked),
      confirmations: context.confirmations.confirmationsOf(note.noteId, note.version, note.event),
    },
  });
}

/**
 * After the agent keys were read again (a key rotation, which follows every revocation): every
 * cached agent version whose agent is now revoked is checked again under the fresh keys (one
 * signed after the revocation is quarantined), kept with them and reported again, flagged, so a
 * cached snapshot's flag doesn't stay stale. Only what the cache holds; without a cache, the
 * next read of the note has the flag.
 */
export async function reportRevokedAgentNotes(context: SyncContext): Promise<void> {
  const { cache, workspaceId } = context;
  if (cache === undefined) return;
  for (const note of await cache.listNotes(workspaceId)) {
    const fields = note.event?.signed?.envelope;
    if (fields?.type !== "agent_edited" || note.version !== fields.version) continue;
    const fresh = await context.verifier.agentKeys.forToken(fields.tokenId);
    if (!anyRevoked(fresh) || anyRevoked(await cachedAgentKeys(context, note))) continue;
    // kept first, so a version signed after the revocation is refused offline from now on too
    // (the fresh records first, so they win over the cached ones; other tokens' records stay)
    const kept = cachedKeys(fresh);
    const newKeys = new Set(kept.agentKeys.map((record) => record.signed.signature));
    const newRevocations = new Set(kept.agentRevocations.map((entry) => entry.signed.signature));
    await cache.putNote({
      ...note,
      agentKeys: [
        ...kept.agentKeys,
        ...(note.agentKeys ?? []).filter((record) => !newKeys.has(record.signed.signature)),
      ],
      agentRevocations: [
        ...kept.agentRevocations,
        ...(note.agentRevocations ?? []).filter(
          (entry) => !newRevocations.has(entry.signed.signature),
        ),
      ],
    });
    let content: NoteContent | null;
    try {
      ({ content } = await verifyCached(context, note, fresh));
    } catch (error) {
      if (!isIntegrityError(error)) throw error;
      await context.quarantine.add(note.noteId, note.version, error);
      continue;
    }
    emitCached(context, note, content, true);
  }
}

/**
 * Reports what the encrypted cache holds, verified again and decrypted in memory, and returns the
 * cursor to pull from. A cached note that no longer verifies is quarantined (and fetched again on
 * the next pull); a workspace or folder name that fails to decrypt resets the cursor to 0, so the
 * next pull fetches everything again.
 */
export async function hydrate(context: SyncContext): Promise<number> {
  const { cache, workspaceId, emitter } = context;
  if (cache === undefined) return 0;
  await context.quarantine.load();
  const state = { complete: true };
  const guard = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      state.complete = false;
      emitter.emit({ type: "error", error });
    }
  };

  const workspace = await cache.getWorkspace(workspaceId);
  if (workspace !== undefined) {
    await guard(async () => {
      const name = await withKeys(context, (keys) =>
        decryptWorkspaceName(keys, workspaceId, workspace.encName),
      );
      emitter.emit({ type: "workspace", name, keyGeneration: workspace.keyGeneration });
    });
  }
  for (const folder of await cache.listFolders(workspaceId)) {
    await guard(async () => {
      const name = folder.deleted
        ? null
        : await withKeys(context, (keys) =>
            decryptFolderName(keys, { workspaceId, folderId: folder.folderId }, folder.encName),
          );
      emitter.emit({
        type: "folder",
        folder: {
          folderId: folder.folderId,
          parentId: folder.parentId,
          name,
          deleted: folder.deleted,
          createdAt: folder.createdAt ?? null,
        },
      });
    });
  }
  for (const attachment of await cache.listAttachments(workspaceId)) {
    await guard(async () => {
      const encMeta = attachment.encMeta;
      const meta =
        attachment.deleted || encMeta === null
          ? null
          : await withKeys(context, (keys) =>
              decryptAttachmentMeta(
                keys,
                {
                  workspaceId,
                  attachmentId: attachment.attachmentId,
                  folderId: attachment.folderId,
                },
                encMeta,
              ),
            );
      emitter.emit({
        type: "attachment",
        attachment: attachmentSnapshot(
          attachment.attachmentId,
          attachment.folderId,
          meta,
          attachment.createdAt ?? null,
        ),
      });
    });
  }
  for (const note of await cache.listNotes(workspaceId)) {
    await guard(() => hydrateNote(context, note));
  }
  return state.complete ? await cache.cursor(workspaceId) : 0;
}
