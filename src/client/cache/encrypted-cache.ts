import { z } from "zod";

import {
  fromBase64Url,
  readEnvelopeHeader,
  type WorkspaceKey,
  type WorkspaceKeys,
} from "../../crypto/index.js";
import { utf8Decode, utf8Encode } from "../../crypto/encoding.js";
import {
  AgentKeyRecord,
  AttachmentId,
  EncAttachmentMeta,
  EncName,
  FolderId,
  KeyGeneration,
  NoteEvent,
  NoteId,
  SignedEvent,
  Timestamp,
  TokenRevocation,
  Version,
  WorkspaceId,
} from "../../protocol/index.js";
import { LOCAL_BLOB_KINDS, type LocalBlobKind } from "../vault/contexts.js";
import {
  decryptLocalBlob,
  decryptSearchIndex,
  encryptLocalBlob,
  encryptSearchIndex,
} from "../vault/search-index.js";
import type { CacheAdapter } from "./adapter.js";

// The local cache holds exactly what the server holds, ciphertext envelopes and the IDs and
// numbers next to them, plus the changes cursor. Everything readable stays in memory. Every
// value goes through a schema or an envelope check on the way in, and keys are built only from
// validated IDs, so a file-backed adapter can use them as paths.

/**
 * A cached note: its metadata, the signed event that made its current version (so the version is
 * verified again when read back), and unless it is deleted, the version's envelope.
 */
export interface CachedNote {
  readonly workspaceId: WorkspaceId;
  readonly noteId: NoteId;
  readonly folderId: FolderId;
  readonly version: number;
  readonly deleted: boolean;
  /** The note version's envelope, exactly as downloaded (absent for a delete marker). */
  readonly ciphertext?: Uint8Array;
  /** The person's signed `edited`, `approved` or `deleted` event for this version. */
  readonly event?: NoteEvent;
  /** When version 1 was stored, if known. */
  readonly createdAt?: string | undefined;
  /**
   * The signed version writes of this note seen so far, verified again when loaded: the person's
   * `edited` and `approved` (the newest 50), which confirm their `human:` entries in later
   * versions too, and apart from them the applied checks (`check_applied`) and agents' writes
   * (`agent_edited`, the newest 50), which tell whether an applied check stands on an agent's
   * version.
   */
  readonly writes?: readonly SignedEvent[];
  /**
   * For an agent's version (`agent_edited`): the owner-signed `agent_key` records of its token,
   * so the version verifies again offline (each record is checked against the owner's key).
   */
  readonly agentKeys?: readonly AgentKeyRecord[];
  /**
   * The owner's signed revocations of that token known when it was cached, so a version signed
   * after one is refused offline too.
   */
  readonly agentRevocations?: readonly TokenRevocation[];
}

const WritesRecord = z.array(SignedEvent).max(100);
const AgentKeysRecord = z.array(AgentKeyRecord).max(20);
const AgentRevocationsRecord = z.array(TokenRevocation).max(20);

/** A note whose newest version failed verification, kept until a pull verifies it. */
export interface QuarantineEntry {
  readonly noteId: NoteId;
  /** The version that failed. */
  readonly version: number;
  /** Why: a `VaultError` or `CryptoError` code. */
  readonly reason: string;
}

/** A cached folder, its name still encrypted. */
export interface CachedFolder {
  readonly workspaceId: WorkspaceId;
  readonly folderId: FolderId;
  readonly parentId: FolderId | null;
  readonly encName: string;
  readonly deleted: boolean;
  /** When the folder was created, if known. */
  readonly createdAt?: string | undefined;
}

const NoteMetaRecord = z.strictObject({
  folderId: FolderId,
  version: Version,
  deleted: z.boolean(),
  createdAt: Timestamp.optional(),
});

const FolderRecord = z.strictObject({
  parentId: FolderId.nullable(),
  encName: EncName,
  deleted: z.boolean(),
  createdAt: Timestamp.optional(),
});

/** A cached attachment, its metadata still encrypted. */
export interface CachedAttachment {
  readonly workspaceId: WorkspaceId;
  readonly attachmentId: AttachmentId;
  readonly folderId: FolderId;
  /** Null for a deleted attachment. */
  readonly encMeta: string | null;
  readonly deleted: boolean;
  /** When the attachment was created, if known. */
  readonly createdAt?: string | undefined;
}

const AttachmentRecord = z.strictObject({
  folderId: FolderId,
  encMeta: EncAttachmentMeta.nullable(),
  deleted: z.boolean(),
  createdAt: Timestamp.optional(),
});

const WorkspaceRecord = z.strictObject({ encName: EncName, keyGeneration: KeyGeneration });

const CursorRecord = z.strictObject({ cursor: Version });

const QuarantineRecord = z.strictObject({
  notes: z.array(
    z.strictObject({
      noteId: NoteId,
      version: Version,
      reason: z.string().regex(/^[a-z_]{1,40}$/),
    }),
  ),
});

function encodeRecord(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

function decodeRecord<T>(schema: z.ZodType<T>, bytes: Uint8Array | undefined): T | undefined {
  if (bytes === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(utf8Decode(bytes)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** A cache key segment for a local blob id: ID characters only. */
const LOCAL_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** Where a local-cache blob lives: `ws/<workspace>/local/<kind>/<id>`. */
function localKey(
  workspaceId: WorkspaceId,
  ref: { readonly kind: LocalBlobKind; readonly id?: string },
): string {
  if (!(LOCAL_BLOB_KINDS as readonly string[]).includes(ref.kind)) {
    throw new Error(`${ref.kind} isn't a local-cache blob kind`);
  }
  const id = ref.id ?? workspaceId;
  if (!LOCAL_ID.test(id) || id === "." || id === "..") {
    throw new Error(`invalid local blob id ${JSON.stringify(id)}`);
  }
  return `${root(workspaceId)}/local/${ref.kind}/${id}`;
}

/** Throws unless `bytes` starts like an envelope from `knowtarium/crypto`. */
function assertEnvelope(bytes: Uint8Array): void {
  readEnvelopeHeader(bytes);
}

function root(workspaceId: WorkspaceId): string {
  return `ws/${WorkspaceId.parse(workspaceId)}`;
}

/**
 * The encrypted cache over a `CacheAdapter`. It stores only ciphertext and non-sensitive
 * metadata; decrypting is the caller's job, with keys that never touch the cache.
 */
export class EncryptedCache {
  constructor(private readonly adapter: CacheAdapter) {}

  /** The changes cursor of a workspace (0 when nothing is cached). */
  async cursor(workspaceId: WorkspaceId): Promise<number> {
    const record = decodeRecord(
      CursorRecord,
      await this.adapter.get(`${root(workspaceId)}/cursor`),
    );
    return record?.cursor ?? 0;
  }

  setCursor(workspaceId: WorkspaceId, cursor: number): Promise<void> {
    return this.adapter.put(
      `${root(workspaceId)}/cursor`,
      encodeRecord(CursorRecord.parse({ cursor })),
    );
  }

  /** Stores a note's metadata and envelope (refusing bytes that aren't an envelope). */
  async putNote(note: CachedNote): Promise<void> {
    const base = `${root(note.workspaceId)}/notes/${NoteId.parse(note.noteId)}`;
    const meta = NoteMetaRecord.parse({
      folderId: note.folderId,
      version: note.version,
      deleted: note.deleted,
      ...(note.createdAt === undefined ? {} : { createdAt: note.createdAt }),
    });
    if (note.deleted || note.ciphertext === undefined) {
      await this.adapter.delete(`${base}/blob`);
    } else {
      assertEnvelope(note.ciphertext);
      await this.adapter.put(`${base}/blob`, note.ciphertext);
    }
    if (note.event === undefined) await this.adapter.delete(`${base}/event`);
    else await this.adapter.put(`${base}/event`, encodeRecord(NoteEvent.parse(note.event)));
    if (note.writes === undefined || note.writes.length === 0) {
      await this.adapter.delete(`${base}/writes`);
    } else {
      await this.adapter.put(`${base}/writes`, encodeRecord(WritesRecord.parse(note.writes)));
    }
    if (note.agentKeys === undefined || note.agentKeys.length === 0) {
      await this.adapter.delete(`${base}/agent-keys`);
    } else {
      await this.adapter.put(
        `${base}/agent-keys`,
        encodeRecord(AgentKeysRecord.parse(note.agentKeys)),
      );
    }
    if (note.agentRevocations === undefined || note.agentRevocations.length === 0) {
      await this.adapter.delete(`${base}/agent-revocations`);
    } else {
      await this.adapter.put(
        `${base}/agent-revocations`,
        encodeRecord(AgentRevocationsRecord.parse(note.agentRevocations)),
      );
    }
    await this.adapter.put(`${base}/meta`, encodeRecord(meta));
  }

  /** The cached version of a note, reading only its metadata (no blob); undefined when absent. */
  async noteVersion(workspaceId: WorkspaceId, noteId: NoteId): Promise<number | undefined> {
    const base = `${root(workspaceId)}/notes/${NoteId.parse(noteId)}`;
    return decodeRecord(NoteMetaRecord, await this.adapter.get(`${base}/meta`))?.version;
  }

  async getNote(workspaceId: WorkspaceId, noteId: NoteId): Promise<CachedNote | undefined> {
    const base = `${root(workspaceId)}/notes/${NoteId.parse(noteId)}`;
    const meta = decodeRecord(NoteMetaRecord, await this.adapter.get(`${base}/meta`));
    if (meta === undefined) return undefined;
    const ciphertext = meta.deleted ? undefined : await this.adapter.get(`${base}/blob`);
    const event = decodeRecord(NoteEvent, await this.adapter.get(`${base}/event`));
    const writes = decodeRecord(WritesRecord, await this.adapter.get(`${base}/writes`));
    const agentKeys = decodeRecord(AgentKeysRecord, await this.adapter.get(`${base}/agent-keys`));
    const agentRevocations = decodeRecord(
      AgentRevocationsRecord,
      await this.adapter.get(`${base}/agent-revocations`),
    );
    return {
      ...(writes === undefined ? {} : { writes }),
      ...(agentKeys === undefined ? {} : { agentKeys }),
      ...(agentRevocations === undefined ? {} : { agentRevocations }),
      workspaceId,
      noteId,
      ...meta,
      ...(ciphertext === undefined ? {} : { ciphertext }),
      ...(event === undefined ? {} : { event }),
    };
  }

  /** Every cached note of a workspace. */
  async listNotes(workspaceId: WorkspaceId): Promise<CachedNote[]> {
    const prefix = `${root(workspaceId)}/notes/`;
    const ids = new Set<NoteId>();
    for (const key of await this.adapter.list(prefix)) {
      const id = NoteId.safeParse(key.slice(prefix.length).split("/")[0]);
      if (id.success) ids.add(id.data);
    }
    const notes = await Promise.all([...ids].map((noteId) => this.getNote(workspaceId, noteId)));
    return notes.filter((note): note is CachedNote => note !== undefined);
  }

  /** Stores a folder with its encrypted name. */
  async putFolder(folder: CachedFolder): Promise<void> {
    assertEnvelope(fromBase64Url(folder.encName));
    const record = FolderRecord.parse({
      parentId: folder.parentId,
      encName: folder.encName,
      deleted: folder.deleted,
      ...(folder.createdAt === undefined ? {} : { createdAt: folder.createdAt }),
    });
    await this.adapter.put(
      `${root(folder.workspaceId)}/folders/${FolderId.parse(folder.folderId)}`,
      encodeRecord(record),
    );
  }

  async listFolders(workspaceId: WorkspaceId): Promise<CachedFolder[]> {
    const prefix = `${root(workspaceId)}/folders/`;
    const folders: CachedFolder[] = [];
    for (const key of await this.adapter.list(prefix)) {
      const folderId = FolderId.safeParse(key.slice(prefix.length));
      const record = decodeRecord(FolderRecord, await this.adapter.get(key));
      if (folderId.success && record !== undefined) {
        folders.push({ workspaceId, folderId: folderId.data, ...record });
      }
    }
    return folders;
  }

  /** Stores an attachment with its encrypted metadata (the bytes stay on the server). */
  async putAttachment(attachment: CachedAttachment): Promise<void> {
    if (attachment.encMeta !== null) assertEnvelope(fromBase64Url(attachment.encMeta));
    const record = AttachmentRecord.parse({
      folderId: attachment.folderId,
      encMeta: attachment.encMeta,
      deleted: attachment.deleted,
      ...(attachment.createdAt === undefined ? {} : { createdAt: attachment.createdAt }),
    });
    await this.adapter.put(
      `${root(attachment.workspaceId)}/attachments/${AttachmentId.parse(attachment.attachmentId)}`,
      encodeRecord(record),
    );
  }

  async listAttachments(workspaceId: WorkspaceId): Promise<CachedAttachment[]> {
    const prefix = `${root(workspaceId)}/attachments/`;
    const attachments: CachedAttachment[] = [];
    for (const key of await this.adapter.list(prefix)) {
      const attachmentId = AttachmentId.safeParse(key.slice(prefix.length));
      const record = decodeRecord(AttachmentRecord, await this.adapter.get(key));
      if (attachmentId.success && record !== undefined) {
        attachments.push({ workspaceId, attachmentId: attachmentId.data, ...record });
      }
    }
    return attachments;
  }

  /** Stores the workspace's encrypted name and current key generation. */
  async putWorkspace(
    workspaceId: WorkspaceId,
    workspace: { readonly encName: string; readonly keyGeneration: number },
  ): Promise<void> {
    assertEnvelope(fromBase64Url(workspace.encName));
    const record = WorkspaceRecord.parse({
      encName: workspace.encName,
      keyGeneration: workspace.keyGeneration,
    });
    await this.adapter.put(`${root(workspaceId)}/workspace`, encodeRecord(record));
  }

  async getWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<{ encName: string; keyGeneration: number } | undefined> {
    return decodeRecord(WorkspaceRecord, await this.adapter.get(`${root(workspaceId)}/workspace`));
  }

  /** The notes waiting for a verified version (see `SyncEngine.quarantined`). */
  async quarantine(workspaceId: WorkspaceId): Promise<QuarantineEntry[]> {
    const record = decodeRecord(
      QuarantineRecord,
      await this.adapter.get(`${root(workspaceId)}/quarantine`),
    );
    return record?.notes ?? [];
  }

  setQuarantine(workspaceId: WorkspaceId, notes: readonly QuarantineEntry[]): Promise<void> {
    return this.adapter.put(
      `${root(workspaceId)}/quarantine`,
      encodeRecord(QuarantineRecord.parse({ notes })),
    );
  }

  /** Encrypts a serialized search index with the current key and stores it. */
  putSearchIndex(workspaceId: WorkspaceId, key: WorkspaceKey, serialized: string): Promise<void> {
    return this.adapter.put(
      `${root(workspaceId)}/search-index`,
      encryptSearchIndex(key, workspaceId, serialized),
    );
  }

  /** The cached search index, decrypted, or undefined when none is cached. */
  async getSearchIndex(workspaceId: WorkspaceId, keys: WorkspaceKeys): Promise<string | undefined> {
    const blob = await this.adapter.get(`${root(workspaceId)}/search-index`);
    return blob === undefined ? undefined : decryptSearchIndex(keys, workspaceId, blob);
  }

  /**
   * Encrypts a local-cache blob (a graph layout, a search index under another id) with the
   * current key and stores it under its kind and id. Never uploaded.
   */
  async putLocalBlob(
    workspaceId: WorkspaceId,
    ref: { readonly kind: LocalBlobKind; readonly id?: string },
    key: WorkspaceKey,
    data: Uint8Array | string,
  ): Promise<void> {
    await this.adapter.put(
      localKey(workspaceId, ref),
      encryptLocalBlob(key, { ...ref, workspaceId }, data),
    );
  }

  /** A local-cache blob, decrypted, or undefined when none is cached. */
  async getLocalBlob(
    workspaceId: WorkspaceId,
    ref: { readonly kind: LocalBlobKind; readonly id?: string },
    keys: WorkspaceKeys,
  ): Promise<Uint8Array | undefined> {
    const blob = await this.adapter.get(localKey(workspaceId, ref));
    return blob === undefined ? undefined : decryptLocalBlob(keys, { ...ref, workspaceId }, blob);
  }

  /** `getLocalBlob` as UTF-8 text. */
  async getLocalText(
    workspaceId: WorkspaceId,
    ref: { readonly kind: LocalBlobKind; readonly id?: string },
    keys: WorkspaceKeys,
  ): Promise<string | undefined> {
    const bytes = await this.getLocalBlob(workspaceId, ref, keys);
    return bytes === undefined ? undefined : utf8Decode(bytes);
  }

  /** Forgets one local-cache blob. */
  async deleteLocalBlob(
    workspaceId: WorkspaceId,
    ref: { readonly kind: LocalBlobKind; readonly id?: string },
  ): Promise<void> {
    await this.adapter.delete(localKey(workspaceId, ref));
  }

  /** Forgets everything cached for a workspace (sign-out, revoked token). */
  async clearWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const keys = await this.adapter.list(`${root(workspaceId)}/`);
    await Promise.all(keys.map((key) => this.adapter.delete(key)));
  }
}
