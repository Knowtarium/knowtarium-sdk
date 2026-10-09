import {
  type AgentPolicyFolder,
  type AgentPolicyFolderInfo,
  type AgentPolicyFolderLookup,
  type AgentWriteMode,
  CHANGES_PAGE_MAX,
  type NoteId,
  type PendingChange,
  type PendingId,
  type CheckStatus,
  type HistoryRetentionDays,
  type HistorySettingsResponse,
  type ServerMessage,
  type SetHistorySettingsResponse,
  type WorkspaceId,
} from "../../protocol/index.js";
import type { NoteFile } from "../../core/files/index.js";
import type { CommentEntry, CommentRecord, Timeline } from "../../core/history/index.js";
import type { ApiClient } from "../api/index.js";
import type { EncryptedCache, QuarantineEntry } from "../cache/index.js";
import { isSyncApiError, SyncStoppedError } from "../errors/index.js";
import {
  addComment,
  loadChecks,
  loadComments,
  loadTimeline,
  type NoteCheckEntry,
  mergeConflict,
  type MergedNote,
  restoreVersion,
  type RestoreVerify,
  type TakenNames,
  undoAgentVersion,
  updateComment,
} from "../history/index.js";
import { LiveConnection, type LiveOptions, type SocketFactory } from "../live/index.js";
import type {
  CheckedAgentPolicy,
  KeyProvider,
  Signer,
  TrustedSigner,
  TrustState,
} from "../vault/index.js";
import { AgentKeyDirectory } from "./agent-keys.js";
import {
  type AgentNoteWrite,
  type AgentPolicyRead,
  auditAgentVersion,
  readAgentPolicy,
  setAgentPolicy,
  writeAsAgent,
} from "./agent-writes.js";
import type { AgentConnection, SyncContext } from "./context.js";
import {
  type NoteSnapshot,
  SyncEmitter,
  type SyncEvent,
  type SyncEventOf,
  type SyncEventType,
} from "./events.js";
import {
  readHistoryRetention,
  readHistorySettings,
  setHistorySettings,
} from "./history-settings.js";
import { hydrate, reportRevokedAgentNotes } from "./hydrate.js";
import { readCurrentNote, readNoteVersion, snapshotOf } from "./notes.js";
import { pullFeed, retryQuarantine } from "./pull.js";
import { Quarantine } from "./quarantine.js";
import { SerialQueue } from "./queue.js";
import type {
  AgentWriteAudit,
  AgentWriteResult,
  ApproveResult,
  PendingReview,
  RejectResult,
  SetAgentPolicyResult,
  SubmitResult,
  WriteConflict,
  WriteResult,
} from "./results.js";
import { Confirmations } from "./confirmations.js";
import { approvePending, readPending, rejectPending, submitPending } from "./review.js";
import { deleteNote, type NoteWrite, writeNote } from "./writes.js";

/** What a sync engine needs for one workspace. */
export interface SyncEngineOptions {
  /** A session client (the web app) or an agent client (the CLI). */
  readonly api: ApiClient;
  readonly workspaceId: WorkspaceId;
  /** The workspace's verified keys (`createKeyProvider`). */
  readonly keys: KeyProvider;
  readonly trust: TrustState;
  /**
   * Whose signatures make a note version current: the owner's signing key from a source the
   * server can't swap (the web app's own account key, the key the CLI pinned at connect).
   */
  readonly verifier: TrustedSigner;
  /** The person's signing key; required for writes, approvals and rejections (session only). */
  readonly identity?: Signer;
  /**
   * The agent's own signing key and token (agent only, protocol 2), for its direct writes
   * (`writeAsAgent`); the owner must have vouched for the key. Without it the agent proposes.
   */
  readonly agent?: AgentConnection;
  /** The encrypted cache; without one, every start pulls from version 0. */
  readonly cache?: EncryptedCache;
  /** Entries per page of the changes feed (at most `CHANGES_PAGE_MAX`). */
  readonly pageSize?: number;
}

/** Live options the engine doesn't fill in itself. */
export type EngineLiveOptions = Omit<
  LiveOptions,
  "api" | "workspaceId" | "connect" | "onMessage" | "onState"
>;

/**
 * Keeps one workspace in sync: pulls the changes feed from a cursor, verifies and decrypts what
 * changed, writes a person's edits with optimistic concurrency, submits an agent's proposals,
 * approves and rejects them, and listens for live pings. Everything it learns goes out as
 * `SyncEvent`s; plaintext stays in memory and only ciphertext reaches the cache and the server.
 *
 * Pulls and writes run one at a time through one queue, so a feed page read before this client's
 * own write can't be applied after it. When access is revoked (a `revoked` ping, a
 * `token_revoked` answer, or a live connection refused for good), the engine stops for good:
 * every call then fails with `SyncStoppedError` and a `revoked` event goes out. The caller then
 * decides about the local data: the CLI deletes its cached ciphertext with
 * `EncryptedCache.clearWorkspace` when its token is revoked, and the web app does the same on
 * sign-out or when the person loses the workspace.
 */
export class SyncEngine {
  private readonly context: SyncContext;
  private readonly pageSize: number;
  private readonly queue = new SerialQueue();
  private cursorValue = 0;
  private loading: Promise<void> | undefined;
  private queuedPull: Promise<number> | undefined;
  private live: LiveConnection | undefined;
  private stopped: SyncStoppedError | undefined;

  constructor(options: SyncEngineOptions) {
    const base = {
      api: options.api,
      workspaceId: options.workspaceId,
      keys: options.keys,
      trust: options.trust,
      // the agent keys are verified against the owner's key here, so callers pass only that
      verifier: {
        owner: options.verifier,
        agentKeys: new AgentKeyDirectory(options.api, options.workspaceId, options.verifier),
      },
      identity: options.identity,
      agent: options.agent,
      folders: new Map<string, AgentPolicyFolderInfo>(),
      noteFolders: new Map<string, string>(),
      cache: options.cache,
      emitter: new SyncEmitter(),
      confirmations: new Confirmations(options.workspaceId, options.verifier),
    };
    this.context = { ...base, quarantine: new Quarantine(base) };
    this.pageSize = options.pageSize ?? CHANGES_PAGE_MAX;
    // the folder tree as the feed and the cache report it, for the agent policy's ancestry
    this.context.emitter.on("folder", ({ folder }) => {
      this.context.folders.set(folder.folderId, {
        parentId: folder.parentId,
        deleted: folder.deleted,
      });
    });
    this.context.emitter.on("note", ({ note }) => {
      this.context.noteFolders.set(note.noteId, note.folderId);
    });
  }

  /** The workspace version the local state is at. */
  get cursor(): number {
    return this.cursorValue;
  }

  /** The notes whose newest version failed verification, retried on every pull. */
  get quarantined(): readonly QuarantineEntry[] {
    return this.context.quarantine.list();
  }

  /** Whether the engine stopped for good because access was revoked. */
  get revoked(): boolean {
    return this.stopped !== undefined;
  }

  /** Listens to every event; returns the function that stops listening. */
  subscribe(listener: (event: SyncEvent) => void): () => void {
    return this.context.emitter.subscribe(listener);
  }

  /** Listens to one type of event; returns the function that stops listening. */
  on<T extends SyncEventType>(type: T, listener: (event: SyncEventOf<T>) => void): () => void {
    return this.context.emitter.on(type, listener);
  }

  /** Runs a task in the engine's queue, unless the engine stopped; a revocation stops it. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    if (this.stopped !== undefined) return Promise.reject(this.stopped);
    return this.queue.run(async () => {
      if (this.stopped !== undefined) throw this.stopped;
      try {
        return await task();
      } catch (error) {
        if (isSyncApiError(error, "token_revoked")) this.revoke();
        throw error;
      }
    });
  }

  /** Stops for good: closes the live connection and refuses every later call. */
  private revoke(): void {
    if (this.stopped !== undefined) return;
    this.stopped = new SyncStoppedError();
    this.live?.stop();
    this.live = undefined;
    this.context.emitter.emit({ type: "revoked" });
  }

  private loadOnce(): Promise<void> {
    if (this.loading === undefined) {
      const loading = hydrate(this.context).then((cursor) => {
        this.cursorValue = cursor;
      });
      // a failed load (no keys offline, say) is tried again by the next call
      loading.catch(() => {
        if (this.loading === loading) this.loading = undefined;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  /**
   * Reports what the encrypted cache holds (verified again and decrypted in memory) and restores
   * the cursor, once. `pull` does it first, so calling it directly only shows cached data sooner.
   */
  load(): Promise<void> {
    return this.run(() => this.loadOnce());
  }

  /**
   * Pulls everything after the cursor: first the quarantined notes again, then the feed page by
   * page, saving the cursor after each page. A pull asked for while one waits in the queue joins
   * it; one asked for while a pull runs queues another, so nothing announced meanwhile is missed.
   * Resolves with the new cursor.
   */
  pull(): Promise<number> {
    this.queuedPull ??= this.run(async () => {
      this.queuedPull = undefined;
      await this.loadOnce();
      await retryQuarantine(this.context);
      await pullFeed(this.context, this.cursorValue, this.pageSize, async (cursor) => {
        this.cursorValue = cursor;
        await this.context.cache?.setCursor(this.context.workspaceId, cursor);
      });
      this.context.emitter.emit({ type: "synced", cursor: this.cursorValue });
      return this.cursorValue;
    });
    return this.queuedPull;
  }

  /** The current version of a note, fetched, verified and decrypted. */
  readNote(noteId: NoteId): Promise<NoteSnapshot> {
    return this.run(() => readCurrentNote(this.context, noteId));
  }

  /**
   * A note's timeline: versions, events, checks and comments, decrypted, with each entry's
   * signature status (see `buildTimeline` in `knowtarium/core`).
   */
  readHistory(noteId: NoteId): Promise<Timeline> {
    return this.run(() => loadTimeline(this.context, noteId));
  }

  /** Comments of one note, or of every note in scope, decrypted and verified. */
  readComments(query: { readonly noteId?: NoteId } = {}): Promise<CommentEntry[]> {
    return this.run(() => loadComments(this.context, query));
  }

  /** Check records of one note or every note in scope (optionally by status), decrypted. */
  readChecks(
    query: { readonly noteId?: NoteId; readonly status?: CheckStatus } = {},
  ): Promise<NoteCheckEntry[]> {
    return this.run(() => loadChecks(this.context, query));
  }

  /**
   * The workspace's history setting with what its history holds by age and the account's usage
   * (session, the owner). `historyFreedAt(breakdown, days)` says what a shorter period removes.
   */
  readHistorySettings(): Promise<HistorySettingsResponse> {
    return this.run(() => readHistorySettings(this.context));
  }

  /**
   * The owner sets the history period (session); a shorter one removes older versions at once,
   * so ask the person to confirm first. Versions removed don't come back with a longer one.
   */
  setHistorySettings(retentionDays: HistoryRetentionDays): Promise<SetHistorySettingsResponse> {
    return this.run(() => setHistorySettings(this.context, retentionDays));
  }

  /**
   * The workspace's history period in days, read-only (agents too); null when the server doesn't
   * say. Versions superseded longer ago than that may have lost their content (`pruned`).
   */
  readHistoryRetention(): Promise<HistoryRetentionDays | null> {
    return this.run(() => readHistoryRetention(this.context));
  }

  /**
   * One version of a note, verified and decrypted (it doesn't become the current one). Throws
   * `VersionPrunedError` when its content was removed after the history period.
   */
  readVersion(noteId: NoteId, version: number): Promise<NoteSnapshot> {
    return this.run(async () =>
      snapshotOf(await readNoteVersion(this.context, { noteId, version })),
    );
  }

  /** Adds a comment or a reply (signed for a person, not for an agent). */
  addComment(
    noteId: NoteId,
    record: CommentRecord,
    options: { readonly signedAt?: string } = {},
  ): Promise<CommentEntry> {
    return this.run(() => addComment(this.context, noteId, record, options));
  }

  /** Stores a comment's next revision (a resolve, an edit); 409 when it changed meanwhile. */
  updateComment(
    comment: Pick<CommentEntry, "id" | "noteId" | "revision">,
    record: CommentRecord,
    options: { readonly signedAt?: string } = {},
  ): Promise<CommentEntry> {
    return this.run(() => updateComment(this.context, comment, record, options));
  }

  /**
   * Restores an old version as a new signed version, with a signed `restored` event (session).
   * Pass `baseVersion` (the version current when the person chose to restore) to make a retry
   * safe: an earlier attempt that got through isn't saved twice. Pass `verify: false` (or a
   * function of the folder that answers false) where agents apply changes directly, so the
   * restore adds no `verified` entry of the person's.
   */
  restoreVersion(
    noteId: NoteId,
    version: number,
    options: {
      readonly baseVersion?: number;
      readonly takenNames: readonly string[];
      readonly signedAt?: string;
      readonly verify?: RestoreVerify;
    },
  ): Promise<WriteResult> {
    return this.run(() => restoreVersion(this.context, noteId, version, options));
  }

  /** The three-way merge of a 409, with the base version fetched and verified. */
  mergeConflict(
    conflict: WriteConflict,
    options: { readonly takenNames: readonly string[] },
  ): Promise<MergedNote> {
    return this.run(() => mergeConflict(this.context, conflict, options));
  }

  /** A person saves a note (session). A 409 returns both versions instead of throwing. */
  writeNote(write: NoteWrite): Promise<WriteResult> {
    return this.run(() => writeNote(this.context, write));
  }

  /** A person deletes a note (session), signed at `signedAt` (see `SigningTime`) or now. */
  deleteNote(target: {
    readonly noteId: NoteId;
    readonly baseVersion: number;
    readonly signedAt?: string;
  }): Promise<WriteResult> {
    return this.run(() => deleteNote(this.context, target));
  }

  /**
   * An agent writes a new version directly, signed with its own key (agent, protocol 2), where
   * the checked agent policy says `direct`. Returns `approval_required` (propose instead with
   * `submitPending`) or `agent_key_required` rather than throwing, and both versions on a 409.
   * Pin the `policyRevision` a save returns.
   */
  writeAsAgent(write: AgentNoteWrite): Promise<AgentWriteResult> {
    return this.run(() => writeAsAgent(this.context, write));
  }

  /**
   * The agent policy, read and checked against the owner's signature and the floor (an agent:
   * its view, with its `agent_key` floor; a person: only the full policy, never a view, with the
   * highest revision signed into the workspace's agent keys as a floor too). `resolved.ok` false:
   * treat every folder as `review`, and don't let a person save over it. With `revision`, an old
   * revision, checked against the signature only. Pass `visibleFolderIds` for every folder the
   * caller knows beyond the engine's.
   */
  readAgentPolicy(options: AgentPolicyRead = {}): Promise<CheckedAgentPolicy> {
    return this.run(() => readAgentPolicy(this.context, options));
  }

  /**
   * The owner replaces the agent policy (session), signed; a `conflict` result carries the
   * current policy when it changed since `baseRevision`.
   */
  setAgentPolicy(change: {
    readonly default: AgentWriteMode;
    readonly folders: readonly AgentPolicyFolder[];
    readonly baseRevision: number;
    readonly signedAt?: string;
    readonly visibleFolderIds?: Iterable<string>;
  }): Promise<SetAgentPolicyResult> {
    return this.run(() => setAgentPolicy(this.context, change));
  }

  /**
   * Checks an agent's version against the policy revision it named (an audit for display; the
   * server enforces the policy). Pass `folders` for the folder's mode under that revision.
   */
  auditAgentVersion(
    noteId: NoteId,
    version: number,
    options: {
      readonly folders?: AgentPolicyFolderLookup;
      readonly visibleFolderIds?: Iterable<string>;
    } = {},
  ): Promise<AgentWriteAudit> {
    return this.run(() => auditAgentVersion(this.context, noteId, version, options));
  }

  /**
   * A person undoes an agent's direct write (session): the version before it comes back as a
   * new signed version with a `restored` event, in that version's folder (an agent's move is
   * undone too; pass `takenNames` and `verify` as functions of that folder, `verify` false where
   * agents apply changes directly), or, for a note the agent created, a signed delete. A conflict when
   * the note moved past `version`.
   */
  undoAgentVersion(
    noteId: NoteId,
    version: number,
    options: {
      readonly takenNames: TakenNames;
      readonly signedAt?: string;
      readonly verify?: RestoreVerify;
    },
  ): Promise<WriteResult> {
    return this.run(() => undoAgentVersion(this.context, noteId, version, options));
  }

  /** An agent proposes a new version (agent). */
  submitPending(proposal: NoteWrite): Promise<SubmitResult> {
    return this.run(() => submitPending(this.context, proposal));
  }

  /** A pending change decrypted for review, with its verified base version. */
  readPending(pendingId: PendingId): Promise<PendingReview> {
    return this.run(() => readPending(this.context, pendingId));
  }

  /**
   * A person approves a pending change with the text to store (session). Pass `signedAt` (see
   * `SigningTime`) when the text names the approval's time, so both agree.
   */
  approvePending(
    pending: PendingChange,
    approved: NoteFile,
    options: { readonly takenNames: readonly string[]; readonly signedAt?: string },
  ): Promise<ApproveResult> {
    return this.run(() => approvePending(this.context, pending, approved, options));
  }

  /** A person rejects a pending change with an encrypted comment record (session). */
  rejectPending(
    pending: PendingChange,
    comment: unknown,
    options: { readonly signedAt?: string } = {},
  ): Promise<RejectResult> {
    return this.run(() => rejectPending(this.context, pending, comment, options));
  }

  /**
   * Opens the live connection: every ping that announces a newer workspace version starts a
   * pull, a key rotation refetches the keys, and the connection reconnects with backoff. A
   * revocation stops the engine.
   */
  connectLive(connect: SocketFactory, options: EngineLiveOptions = {}): LiveConnection {
    if (this.stopped !== undefined) throw this.stopped;
    this.live?.stop();
    const live = new LiveConnection({
      ...options,
      api: this.context.api,
      workspaceId: this.context.workspaceId,
      connect,
      onMessage: (message) => {
        this.onLiveMessage(message);
      },
      onState: (state) => {
        this.context.emitter.emit({ type: "live", state });
        if (state === "revoked") this.revoke();
      },
    });
    this.live = live;
    live.start();
    return live;
  }

  /** Closes the live connection (the engine keeps working; `connectLive` opens it again). */
  stop(): void {
    this.live?.stop();
    this.live = undefined;
  }

  private onLiveMessage(message: ServerMessage): void {
    const { emitter } = this.context;
    switch (message.type) {
      case "hello":
      case "changed":
      case "pending_added":
      case "pending_decided":
      case "check_added":
        if (message.workspaceVersion > this.cursorValue) {
          this.pull().catch((error: unknown) => {
            if (!(error instanceof SyncStoppedError)) emitter.emit({ type: "error", error });
          });
        }
        return;
      case "keys_rotated":
        // a rotation follows every revocation: read the agent keys' revocations again too
        this.context.verifier.agentKeys.invalidate();
        this.context.keys.refresh().then(
          (keys) => {
            emitter.emit({ type: "keys_rotated", keyGeneration: keys.current.generation });
            // cached agent versions whose agent is now revoked are reported again, flagged
            this.run(() => reportRevokedAgentNotes(this.context)).catch((error: unknown) => {
              if (!(error instanceof SyncStoppedError)) emitter.emit({ type: "error", error });
            });
          },
          (error: unknown) => {
            emitter.emit({ type: "error", error });
          },
        );
        return;
      case "revoked":
        this.revoke();
        return;
      case "pong":
        return;
    }
  }
}
