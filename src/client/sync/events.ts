import type { AttachmentId, ChangeEntry, FolderId, NoteId } from "../../protocol/index.js";
import type { QuarantineEntry } from "../cache/index.js";
import type { Confirmation } from "./confirmations.js";
import type { LiveState } from "../live/index.js";
import type { AgentWrite } from "../vault/index.js";

/** A note as the client knows it after verifying and decrypting it. */
export interface NoteSnapshot {
  readonly noteId: NoteId;
  readonly folderId: FolderId;
  readonly version: number;
  /**
   * The note's file name within its folder (`pricing.md`), from inside the ciphertext; null for a
   * delete marker.
   */
  readonly name: string | null;
  /** The OKF markdown file; null for a delete marker. */
  readonly text: string | null;
  /**
   * When the note's version 1 was stored (from the server; null when unknown, as for an old
   * cache). The oldest note keeps a contested file name in `buildWorkspacePaths`.
   */
  readonly createdAt: string | null;
  /**
   * The person's signed write that made this version, verified against the trusted key: the
   * account that signed its `edited` or `approved` envelope and the envelope's `createdAt`. That
   * write confirms exactly one `human:` entry, `human:<by>` at `at` (the rule the web app and the
   * CLI share); null for a delete marker or any other envelope (`check_applied` never confirms a
   * person's entry).
   */
  readonly signedWrite: { readonly by: string; readonly at: string } | null;
  /**
   * An agent's direct write that made this version (`agent_edited`, under a key the owner
   * vouched for): its token, when it signed, the agent policy revision it checked, and whether
   * the agent was revoked since (its earlier versions stay valid, flagged). Null for any other
   * version. It confirms no `human:` entry: an agent's version waits for a person.
   */
  readonly agentWrite: AgentWrite | null;
  /**
   * Every verified signed write of the note up to this version that the engine has seen
   * (`edited` and `approved`, never `check_applied`), oldest first: each confirms `human:<by>` at
   * `at` from its version on, so a person's entry stays confirmed after an applied check or an
   * approved proposal adds a version. None for an agent's version, nor for an applied check on
   * top of one (or on a version the engine can't tell was a person's).
   */
  readonly confirmations: readonly Confirmation[];
}

/** A folder with its decrypted name. */
export interface FolderSnapshot {
  readonly folderId: FolderId;
  readonly parentId: FolderId | null;
  /** Null when the folder is deleted. */
  readonly name: string | null;
  readonly deleted: boolean;
  /** When the folder was created (null when unknown). */
  readonly createdAt: string | null;
}

/**
 * An attachment with its decrypted metadata (from the changes feed or the encrypted cache): its
 * folder, file name, media type and plaintext size; name, type and size are null for a deleted
 * one. Download the bytes with `downloadAttachment`.
 */
export interface AttachmentSnapshot {
  readonly attachmentId: AttachmentId;
  readonly folderId: FolderId;
  readonly name: string | null;
  readonly type: string | null;
  readonly sizeBytes: number | null;
  readonly deleted: boolean;
  /**
   * When the attachment was created (from the server; null when unknown, as for an old cache):
   * of two attachments with the same name in a folder, resolve to the oldest.
   */
  readonly createdAt: string | null;
}

/** An attachment's snapshot from its decrypted metadata (null for a deleted attachment). */
export function attachmentSnapshot(
  attachmentId: AttachmentId,
  folderId: FolderId,
  meta: { readonly name: string; readonly type: string; readonly sizeBytes: number } | null,
  createdAt: string | null,
): AttachmentSnapshot {
  return {
    attachmentId,
    folderId,
    createdAt,
    name: meta?.name ?? null,
    type: meta?.type ?? null,
    sizeBytes: meta?.sizeBytes ?? null,
    deleted: meta === null,
  };
}

/** Records the engine doesn't decrypt itself; the app refetches them (for example with a query). */
export type RecordChange = Extract<
  ChangeEntry,
  { kind: "pending" | "event" | "comment" | "check" }
>;

/**
 * What the sync engine reports. The web app's query layer maps these onto its cache
 * (`note` and `folder` set data, `change` invalidates the matching queries).
 */
export type SyncEvent =
  | { readonly type: "note"; readonly note: NoteSnapshot }
  | { readonly type: "folder"; readonly folder: FolderSnapshot }
  | { readonly type: "attachment"; readonly attachment: AttachmentSnapshot }
  | {
      readonly type: "workspace";
      readonly name: string;
      readonly keyGeneration: number;
      /**
       * The agent policy's current revision, as the feed announced it (absent from older servers
       * and while the workspace has none): a new one means read the policy again.
       */
      readonly agentPolicyRevision?: number;
    }
  | { readonly type: "change"; readonly change: RecordChange }
  | { readonly type: "synced"; readonly cursor: number }
  | { readonly type: "live"; readonly state: LiveState }
  | { readonly type: "keys_rotated"; readonly keyGeneration: number }
  /** Access is gone for good: the engine stopped (see `SyncEngine`). */
  | { readonly type: "revoked" }
  /** The notes whose newest version failed verification, each time the set changes. */
  | { readonly type: "quarantine"; readonly notes: readonly QuarantineEntry[] }
  /** Something failed; a note that fails verification is skipped, never shown. */
  | { readonly type: "error"; readonly error: unknown; readonly noteId?: NoteId };

/** The `type` of a `SyncEvent`. */
export type SyncEventType = SyncEvent["type"];

/** The event of one type. */
export type SyncEventOf<T extends SyncEventType> = Extract<SyncEvent, { type: T }>;

/** A small typed emitter; a listener that throws never stops the others or the sync. */
export class SyncEmitter {
  private readonly listeners = new Set<(event: SyncEvent) => void>();

  /** Listens to every event; returns the function that stops listening. */
  subscribe(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Listens to one type of event; returns the function that stops listening. */
  on<T extends SyncEventType>(type: T, listener: (event: SyncEventOf<T>) => void): () => void {
    return this.subscribe((event) => {
      if (event.type === type) listener(event as SyncEventOf<T>);
    });
  }

  emit(event: SyncEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a broken listener must not break the sync or the other listeners
      }
    }
  }
}
