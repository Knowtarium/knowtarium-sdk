import type { CheckRecordSignal } from "../../core/index.js";
import { boxKeyPairFromPrivateKey, fromBase64Url } from "../../crypto/index.js";
import {
  type AgentPolicyFolderLookup,
  type AgentPolicyViewResult,
  type AgentWriteMode,
  agentPolicyAncestry,
  effectiveMode,
  type FolderId,
  type NoteId,
  routes,
  type WorkspaceId,
} from "../../protocol/index.js";
import {
  type ApiClient,
  type CacheAdapter,
  createApiClient,
  type EncryptedCache,
  type FetchLike,
  fetchAgentPolicy,
  isSyncApiError,
  type KeyProvider,
  NetworkError,
  readHistoryRetention,
  type SocketFactory,
  SyncEngine,
  type TrustState,
} from "../../client/index.js";
import { agentSigningKeyPair, type Connection, writesDirectly } from "../storage/credentials.js";
import { mcpUpdateMessage } from "../update.js";
import { cachedKeyProvider, isUnreachable } from "./key-cache.js";
import { describePlanLimit } from "./plan-limits.js";
import { WorkspaceView } from "./view.js";

/** What a session needs from the CLI. */
export interface SessionDeps {
  readonly fetch: FetchLike;
  readonly trust: TrustState;
  /** The encrypted cache, over `adapter`. */
  readonly cache: EncryptedCache;
  /** The raw cache store, where the signed wrapped keys are kept for offline starts. */
  readonly adapter: CacheAdapter;
  /** Writes a line to stderr (stdout carries the MCP protocol). */
  readonly log: (line: string) => void;
  /**
   * Whether the connection is still saved: `knowtarium disconnect` in another terminal removes it
   * (and wipes the cache), and the session then stops. Defaults to always.
   */
  readonly stillConnected?: () => Promise<boolean>;
  /** Called once when the session finds its connection removed (to stop cache writes). */
  readonly onDisconnected?: () => void;
  /**
   * How long to wait before the first retry after a failed sync (the API couldn't be reached, or
   * anything else that may pass, like an invalid response); each failure in a row doubles it, up
   * to `maxRetryAfterMs`. Defaults: 15 seconds, 15 minutes.
   */
  readonly retryAfterMs?: number;
  readonly maxRetryAfterMs?: number;
  /** How long a tool call waits for the retry it starts (default 10 seconds). */
  readonly retryWaitMs?: number;
  /** The fewest milliseconds between two retries tool calls start (default 2 seconds). */
  readonly retryOnCallMinMs?: number;
  /** The clock, in milliseconds (tests). */
  readonly now?: () => number;
  /** The API client's retry policy (tests make it one attempt). */
  readonly apiRetry?: Parameters<typeof createApiClient>[0]["retry"];
}

/** How long a verified agent policy answers the read-only tools without a new request. */
const POLICY_CACHE_MS = 30_000;
/** How long one such read may take: the tools answer from the last policy after that. */
const POLICY_READ_TIMEOUT_MS = 5_000;
/** How long the workspace's history period answers the tools without a new request. */
const HISTORY_RETENTION_CACHE_MS = 5 * 60_000;
/**
 * The longest `Retry-After` an agent's direct write waits out before answering `rate_limited`,
 * so the tool answers promptly (the agent is told how long to wait instead).
 */
const WRITE_MAX_RETRY_AFTER_MS = 5_000;

/**
 * Where a session is: `loading` until the local copy is open, `syncing` while the first pull
 * runs (answers may be partial), `ready`, `offline` (the API can't be reached: answers come from
 * the local copy, if any), `revoked`, `disconnected` (removed by `knowtarium disconnect`), or
 * `failed` (anything else, with the reason). `offline` and `failed` are retried with backoff, and
 * `failed` also on the next tool call; `revoked` and `disconnected` are final.
 */
export type SessionStatus =
  "loading" | "syncing" | "ready" | "offline" | "revoked" | "disconnected" | "failed";

/**
 * One connected workspace behind the MCP server: the agent's API client, its verified workspace
 * keys (unwrapped with the CLI's own key, signatures checked against the owner key pinned at
 * connect, kept in the cache for offline starts), the sync engine over the encrypted on-disk
 * cache, the in-memory view the tools read, and the unapplied check records. It starts in the
 * background and never throws out of it: a failure becomes its status, which the tools report.
 */
export class WorkspaceSession {
  readonly api: ApiClient;
  readonly keys: KeyProvider;
  readonly engine: SyncEngine;
  readonly view: WorkspaceView;
  status: SessionStatus = "loading";
  /** Why the session is offline, revoked, disconnected or failed. */
  problem: string | null = null;
  /** Whether a complete local copy is open (notes can be answered from it). */
  loaded = false;
  private readonly checks = new Map<NoteId, CheckRecordSignal[]>();
  /** The notes `read_note` returned in this session (what a check may name as its scope). */
  private readonly read = new Set<NoteId>();
  /** The last agent policy that verified, for when it can't be read, and when it was read. */
  private lastPolicy: Extract<AgentPolicyViewResult, { ok: true }> | null = null;
  private lastPolicyAt = Number.NEGATIVE_INFINITY;
  /** The policy read running now, if any (concurrent tools share it). */
  private policyRead: Promise<AgentPolicyViewResult | null> | undefined;
  /** The history period last read (days), when, and the read running now, if any. */
  private lastRetention: number | null = null;
  private lastRetentionAt = Number.NEGATIVE_INFINITY;
  private retentionRead: Promise<number | null> | undefined;
  /** The client for policy reads: one attempt, a short timeout. */
  private readonly policyApi: ApiClient;
  private started: Promise<void> | undefined;
  private retry: NodeJS.Timeout | undefined;
  /** The sync running now, if any (one at a time). */
  private running: Promise<void> | undefined;
  /** Failed syncs in a row (the backoff doubles with each). */
  private failures = 0;
  /** When the last sync started, by `deps.now`. */
  private lastAttempt = Number.NEGATIVE_INFINITY;

  private constructor(
    readonly connection: Connection,
    private readonly deps: SessionDeps,
    private readonly ownerKey: Uint8Array,
  ) {
    const workspaceId = connection.workspaceId;
    const client = (options: Partial<Parameters<typeof createApiClient>[0]> = {}) =>
      createApiClient({
        baseUrl: connection.apiUrl,
        fetch: deps.fetch,
        auth: { kind: "agent", token: connection.tokenSecret },
        ...(deps.apiRetry === undefined ? {} : { retry: deps.apiRetry }),
        ...options,
      });
    const base = client();
    // a direct write doesn't wait out a long Retry-After: the tool says how long to wait
    const writes = client({
      retry: { ...deps.apiRetry, maxRetryAfterMs: WRITE_MAX_RETRY_AFTER_MS },
    });
    this.api = {
      baseUrl: base.baseUrl,
      auth: base.auth,
      call: (route, ...args) =>
        (route.path === routes.writeNoteAsAgent.path && route.method === "PUT"
          ? writes
          : base
        ).call(route, ...args),
    };
    this.policyApi = client({
      retry: { ...deps.apiRetry, maxAttempts: 1 },
      timeoutMs: POLICY_READ_TIMEOUT_MS,
    });
    this.keys = cachedKeyProvider(
      this.api,
      {
        workspaceId,
        recipient: boxKeyPairFromPrivateKey(fromBase64Url(connection.agentPrivateKey)),
        ownerSigningPublicKey: ownerKey,
        ownerAccountId: connection.ownerId,
        trust: deps.trust,
      },
      deps.adapter,
    );
    const signing = agentSigningKeyPair(connection);
    this.engine = new SyncEngine({
      api: this.api,
      workspaceId,
      keys: this.keys,
      trust: deps.trust,
      verifier: { publicKey: ownerKey, accountId: connection.ownerId },
      cache: deps.cache,
      // a connection made before direct writes has no key of its own: it only proposes
      ...(signing === null
        ? {}
        : { agent: { tokenId: connection.tokenId, signing, folderIds: connection.folderIds } }),
    });
    this.view = new WorkspaceView(this.engine, connection.folderIds, connection.ownerId);
    // the feed announces a new policy revision: read it again on the next use
    this.engine.subscribe((event) => {
      if (
        event.type === "workspace" &&
        event.agentPolicyRevision !== undefined &&
        event.agentPolicyRevision !== this.lastPolicy?.revision
      ) {
        this.lastPolicyAt = Number.NEGATIVE_INFINITY;
      }
    });
    this.engine.on("revoked", () => {
      this.settle("revoked", revokedProblem(workspaceId));
    });
  }

  /** A session for a saved connection; the owner key is the pinned one, never the server's. */
  static async open(connection: Connection, deps: SessionDeps): Promise<WorkspaceSession> {
    const pinned = await deps.trust.ownerKey(connection.workspaceId);
    return new WorkspaceSession(
      connection,
      deps,
      pinned ?? fromBase64Url(connection.ownerSignPublicKey),
    );
  }

  get workspaceId(): WorkspaceId {
    return this.connection.workspaceId;
  }

  /** Whether the token may change notes (propose, or write directly). */
  get writable(): boolean {
    return this.connection.access === "read-write";
  }

  /**
   * Whether this connection may write directly where the workspace allows it: it has its own
   * signing key and the owner vouched for it at connect. Otherwise it only proposes.
   */
  get writesDirectly(): boolean {
    return writesDirectly(this.connection);
  }

  /** The lowest agent policy revision this connection accepts: its `agent_key`'s. */
  get policyFloor(): number {
    return this.connection.agentKey?.envelope.policyRevision ?? 0;
  }

  /**
   * The agent policy for the read-only uses (what the tools show, which guards apply), checked
   * against the pinned owner key, the token's folders, the folders this session sees and the
   * floor (the `agent_key`'s and this device's). A verified one is reused for 30 seconds (or until
   * the feed announces another revision); until the session is ready (still syncing, offline,
   * failed), or when a read fails or takes over 5 seconds, the last verified one answers. Null when there is none, which callers read as `review` everywhere; a
   * view that fails a check comes back as such (`ok: false`): `review` everywhere too. Direct
   * writes don't use this: `writeAsAgent` reads and checks the policy itself, every time.
   */
  agentPolicy(): Promise<AgentPolicyViewResult | null> {
    // never wait on an API that is slow, unreachable or still being synced with
    if (this.status !== "ready") return Promise.resolve(this.lastPolicy);
    if (this.lastPolicy !== null && this.now() - this.lastPolicyAt < POLICY_CACHE_MS) {
      return Promise.resolve(this.lastPolicy);
    }
    this.policyRead ??= this.readPolicy().finally(() => {
      this.policyRead = undefined;
    });
    return this.policyRead;
  }

  /**
   * The workspace's history period in days (read-only: only the owner sets it), reused for five
   * minutes. Until the session is ready, or when a read fails or the server doesn't say, the last
   * one known answers; null when none is.
   */
  historyRetention(): Promise<number | null> {
    if (this.status !== "ready") return Promise.resolve(this.lastRetention);
    if (
      this.lastRetention !== null &&
      this.now() - this.lastRetentionAt < HISTORY_RETENTION_CACHE_MS
    ) {
      return Promise.resolve(this.lastRetention);
    }
    this.retentionRead ??= readHistoryRetention({
      api: this.policyApi,
      workspaceId: this.workspaceId,
    })
      .then((days) => {
        if (days !== null) {
          this.lastRetention = days;
          this.lastRetentionAt = this.now();
        }
        return this.lastRetention;
      })
      .catch(() => this.lastRetention)
      .finally(() => {
        this.retentionRead = undefined;
      });
    return this.retentionRead;
  }

  private async readPolicy(): Promise<AgentPolicyViewResult | null> {
    try {
      const { resolved } = await fetchAgentPolicy(this.policyApi, {
        workspaceId: this.workspaceId,
        ownerSigningPublicKey: this.ownerKey,
        ownerAccountId: this.connection.ownerId,
        trust: this.deps.trust,
        visibleFolderIds: [...this.view.folders.keys()],
        scopeFolderIds: this.connection.folderIds,
        view: true,
        minRevision: this.policyFloor,
      });
      if (resolved.ok) {
        this.lastPolicy = resolved;
        this.lastPolicyAt = this.now();
      }
      return resolved;
    } catch {
      return this.lastPolicy;
    }
  }

  /** The folders as the view knows them, for the policy's ancestry. */
  private readonly folderLookup: AgentPolicyFolderLookup = (folderId) => {
    const folder = this.view.folders.get(folderId as FolderId);
    return folder === undefined ? undefined : { parentId: folder.parentId, deleted: false };
  };

  /**
   * Whether the workspace asks for a person's approval of agent changes in a folder (`review`) or
   * lets them apply (`direct`), by a checked policy (`agentPolicy`). Anything unverified, or no
   * policy known, is `review`: today's behavior, with every check and guard.
   */
  folderMode(folderId: FolderId, policy: AgentPolicyViewResult | null): AgentWriteMode {
    if (policy?.ok !== true) return "review";
    return effectiveMode(policy.rules, agentPolicyAncestry(folderId, this.folderLookup));
  }

  /** Whether the session has stopped for good (revoked or disconnected). */
  get ended(): boolean {
    return this.status === "revoked" || this.status === "disconnected";
  }

  private settle(status: SessionStatus, problem: string | null): void {
    if (this.ended) return;
    const changed = this.status !== status || this.problem !== problem;
    this.status = status;
    this.problem = problem;
    if (changed && problem !== null) this.deps.log(`knowtarium (${this.workspaceId}): ${problem}`);
    if (status === "revoked" || status === "disconnected") {
      clearTimeout(this.retry);
      this.engine.stop();
    }
  }

  private fail(error: unknown): void {
    if (isSyncApiError(error, "token_revoked") || isSyncApiError(error, "unauthenticated")) {
      this.settle("revoked", revokedProblem(this.workspaceId));
      return;
    }
    this.failures++;
    if (isUnreachable(error)) this.settle("offline", describeFailure(error));
    // the last error, shown only while retries are pending: a sync that works clears it
    else this.settle("failed", `${describeFailure(error)} Trying again automatically.`);
    this.scheduleRetry();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The wait before the next retry: doubled for each failure in a row, capped. */
  private retryDelay(): number {
    const first = this.deps.retryAfterMs ?? 15_000;
    const max = this.deps.maxRetryAfterMs ?? 15 * 60_000;
    return Math.min(max, first * 2 ** Math.min(Math.max(0, this.failures - 1), 30));
  }

  private scheduleRetry(): void {
    clearTimeout(this.retry);
    if (this.ended) return;
    this.retry = setTimeout(() => {
      void this.sync();
    }, this.retryDelay());
    this.retry.unref();
  }

  /**
   * A tool call on a failed session tries again at once (at most every `retryOnCallMinMs`) and
   * waits for it up to `retryWaitMs`, so a passing failure (an invalid response, a hiccup) doesn't
   * keep the workspace failed until the next scheduled retry. Never rejects.
   */
  async retryOnCall(): Promise<void> {
    // only a failed session: a first sync or an offline one keeps answering from the local copy
    if (this.status !== "failed") return;
    const pending =
      this.running ??
      (this.now() - this.lastAttempt >= (this.deps.retryOnCallMinMs ?? 2_000)
        ? this.sync()
        : undefined);
    if (pending === undefined) return;
    await within(pending, this.deps.retryWaitMs ?? 10_000);
  }

  /**
   * Waits, at most `maxMs`, for the first sync to end (or fail), so the status says whether this
   * agent's access was revoked: the first pull is where that shows. Never rejects.
   */
  async firstSync(maxMs: number): Promise<void> {
    if (this.started !== undefined) await within(this.started, maxMs);
  }

  /**
   * Opens the local copy (the encrypted cache, the search index), then pulls what changed and
   * the unapplied check records. Never rejects; call it without waiting so the MCP server
   * answers at once.
   */
  start(): Promise<void> {
    this.started ??= (async () => {
      try {
        await this.engine.load();
        // a cache that never finished a pull is no local copy to answer from
        this.loaded = this.engine.cursor > 0;
        if (this.loaded) await this.restoreIndex();
      } catch (error) {
        this.fail(error);
        if (this.ended) return;
      }
      await this.sync();
    })();
    return this.started;
  }

  private async restoreIndex(): Promise<void> {
    try {
      const serialized = await this.deps.cache.getSearchIndex(
        this.workspaceId,
        await this.keys.get(),
      );
      if (serialized !== undefined) this.view.restoreIndex(serialized);
    } catch {
      // a stale index is rebuilt on first use
    }
  }

  /** Whether the connection is still saved; stops the session when it isn't. */
  async connected(): Promise<boolean> {
    if (this.status === "disconnected") return false;
    if (this.deps.stillConnected === undefined || (await this.deps.stillConnected())) return true;
    this.settle(
      "disconnected",
      "This workspace was disconnected on this computer (`knowtarium disconnect`); connect it again with `npx knowtarium connect`, then restart the agent.",
    );
    this.deps.onDisconnected?.();
    return false;
  }

  /**
   * Pulls the changes feed and the unapplied checks, then saves the search index (encrypted). One
   * runs at a time (a second call joins it); a failure schedules the next retry. Never rejects.
   */
  sync(): Promise<void> {
    this.running ??= this.syncOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async syncOnce(): Promise<void> {
    if (this.ended || !(await this.connected())) return;
    clearTimeout(this.retry);
    this.lastAttempt = this.now();
    if (this.status !== "loading") this.status = this.loaded ? "syncing" : "loading";
    try {
      await this.engine.pull();
      this.loaded = true;
      await this.refreshChecks();
      this.failures = 0;
      this.settle("ready", null);
      await this.saveIndex();
    } catch (error) {
      this.fail(error);
    }
  }

  private async saveIndex(): Promise<void> {
    if (this.ended || !(await this.connected())) return;
    const keys = await this.keys.get();
    await this.deps.cache.putSearchIndex(
      this.workspaceId,
      keys.current,
      this.view.search().serialize(),
    );
  }

  /** Reloads the check records no client has applied yet. */
  private async refreshChecks(): Promise<void> {
    const records = await this.engine.readChecks({ status: "unapplied" });
    this.checks.clear();
    for (const record of records) {
      if (record.findings === null) continue;
      this.addCheck({
        id: record.id,
        noteId: record.noteId,
        version: record.noteVersion,
        by: record.findings.actor,
        at: record.findings.at,
        result: record.findings.result,
      });
    }
  }

  /** Counts a check record (one this agent just filed, say) until a client applies it. */
  addCheck(signal: CheckRecordSignal): void {
    const noteId = signal.noteId as NoteId;
    this.checks.set(noteId, [
      ...(this.checks.get(noteId) ?? []).filter((entry) => entry.id !== signal.id),
      signal,
    ]);
  }

  /** Remembers that the agent read a note in this session. */
  markRead(noteId: NoteId): void {
    this.read.add(noteId);
  }

  /** Whether the agent read a note in this session. */
  hasRead(noteId: NoteId): boolean {
    return this.read.has(noteId);
  }

  /** The unapplied check records of a note. */
  checksFor(noteId: NoteId): readonly CheckRecordSignal[] {
    return this.checks.get(noteId) ?? [];
  }

  /** Keeps the cache fresh while the server runs: live pings start pulls. */
  goLive(connect: SocketFactory): void {
    if (this.ended) return;
    this.engine.on("synced", () => {
      void this.refreshChecks()
        .then(() => this.saveIndex())
        .catch(() => undefined);
    });
    this.engine.connectLive(connect);
  }

  /** Stops syncing (the server is shutting down). */
  stop(): void {
    clearTimeout(this.retry);
    this.engine.stop();
  }

  /** Whether a folder is inside the token's scope. */
  inScope(folderId: FolderId): boolean {
    return this.view.inScope(folderId);
  }
}

/** Settles when `promise` does or after `ms`, whichever comes first. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}

/** The command that removes a connection from this computer. */
export function disconnectCommandFor(workspaceId: string): string {
  return `npx knowtarium disconnect --workspace ${workspaceId}`;
}

/**
 * Why a revoked workspace can't answer, with both ways out: remove the connection (the access was
 * taken away on purpose, or its account is gone) or connect it again.
 */
function revokedProblem(workspaceId: WorkspaceId): string {
  return `This agent's access to workspace ${workspaceId} was revoked (in the web app, or its account was deleted), so this connection can't be used any more. To remove it from this computer, run \`${disconnectCommandFor(workspaceId)}\`; to keep using the workspace, run \`npx knowtarium connect\` to connect it again. Then restart the agent.`;
}

/** A sentence for a failed API call, saying what to do. */
export function describeFailure(error: unknown): string {
  if (error instanceof NetworkError) {
    return "Knowtarium can't be reached right now; answers come from the local encrypted copy.";
  }
  if (isSyncApiError(error)) {
    switch (error.code) {
      case "token_revoked":
      case "unauthenticated":
        return "This agent's access was revoked. Run `npx knowtarium connect` to connect again, then restart the agent so it picks up the new connection.";
      case "quota_exceeded":
      case "workspace_limit":
        // the parsed body always carries both; a made-up one (a proxy's page) never has these codes
        return error.detail.code === "quota_exceeded" || error.detail.code === "workspace_limit"
          ? describePlanLimit(error.detail)
          : "A Knowtarium plan limit refused this change.";
      case "scope_denied":
        return "That is outside the folders this agent may use.";
      case "rate_limited":
        return "Too many requests; wait a moment and try again.";
      case "unsupported_protocol":
        return mcpUpdateMessage(error);
      default:
        return error.status >= 500
          ? "Knowtarium is having trouble right now; answers come from the local encrypted copy."
          : `Knowtarium refused the request (${error.code}).`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
