import { type Actor, type CheckRecordSignal, parseNote, setGenerated } from "../../core/index.js";
import { boxKeyPairFromPrivateKey, fromBase64Url } from "../../crypto/index.js";
import {
  type AgentPermission,
  type AgentPolicyFolderLookup,
  type AgentPolicyViewResult,
  agentScopeAllows,
  type AgentWriteMode,
  agentPolicyAncestry,
  effectiveMode,
  type FolderId,
  type NoteId,
  routes,
  type SignedInboxKey,
  STALE_CLOSE_CODE,
  type TokenAccess,
  type WorkspaceId,
} from "../../protocol/index.js";
import {
  type AgentScopeProblem,
  type ApiClient,
  type CacheAdapter,
  type ClipFolder,
  createApiClient,
  type EncryptedCache,
  type FetchLike,
  fetchAgentPolicy,
  fetchInboxKey,
  type FileClipsResult,
  isSyncApiError,
  isVaultError,
  type KeyProvider,
  NetworkError,
  readHistoryRetention,
  type SocketFactory,
  SyncEngine,
  type TrustState,
  verifyAgentScope,
} from "../../client/index.js";
import {
  agentSigningKeyPair,
  type AgentScopeFloor,
  type Connection,
  hasVouchedKey,
  type ScopeFloorStore,
} from "../storage/credentials.js";
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
  /**
   * The agent's actor, as its `generated` stamps and unsigned `clipped` records name the clips it
   * files in the background (the MCP client's, once it said; `knowtarium-cli/<version>` before).
   */
  readonly actor?: () => Actor;
  /** The API client's retry policy (tests make it one attempt). */
  readonly apiRetry?: Parameters<typeof createApiClient>[0]["retry"];
  /**
   * Where the token's verified scope floor is kept (`agent-scopes.enc`, through `Credentials`);
   * without it, only in memory.
   */
  readonly scopes?: ScopeFloorStore;
}

/**
 * The token's scope as a session acts on it (protocol 3): its access, folders and permissions,
 * from the owner's signed `agent_scope` once it verified under the pinned owner key, else (a
 * token at revision 0, connected before scopes were signed) the access and folders saved at
 * connect, with no permissions.
 */
export interface SessionScope {
  /** The scope revision (0: never signed). */
  readonly revision: number;
  readonly access: TokenAccess;
  /** Empty: the whole workspace. */
  readonly folderIds: readonly FolderId[];
  readonly permissions: readonly AgentPermission[];
  /** Whether it comes from the owner's signed scope, verified. */
  readonly verified: boolean;
  /** That signed scope's `scopeSha256` (null at revision 0): the next revision must chain to it. */
  readonly scopeSha256: string | null;
  /**
   * Why the scope the server served was refused (the last verified one stays in force): a
   * rollback below the floor, a bad signature and the like. Null when it was accepted.
   */
  readonly problem: AgentScopeProblem | null;
}

/** A connection's scope from what it saved at connect: revision 0, no permissions. */
function connectScope(connection: Connection): SessionScope {
  return {
    revision: 0,
    access: connection.access,
    folderIds: connection.folderIds,
    permissions: [],
    verified: false,
    scopeSha256: null,
    problem: null,
  };
}

/** A session scope from a verified signed scope. */
function verifiedScope(floor: Pick<AgentScopeFloor, "revision" | "signed">): SessionScope {
  return {
    revision: floor.revision,
    access: floor.signed.scope.access,
    folderIds: floor.signed.scope.folderIds,
    permissions: floor.signed.scope.permissions,
    verified: true,
    scopeSha256: floor.signed.envelope.scopeSha256,
    problem: null,
  };
}

/** Whether two scopes reach different notes (access or folders), so the local copy must go. */
function reachChanged(a: SessionScope, b: SessionScope): boolean {
  const folders = (scope: SessionScope) => [...new Set(scope.folderIds)].sort().join(",");
  return a.access !== b.access || folders(a) !== folders(b);
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

/** How long one filing pass of the web clipper's clips may take (`list_inbox` waits for it). */
export const CLIP_FILING_MAX_MS = 5_000;

/** What the last look at the web clipper's inbox found: its inbox key and the last filing pass. */
export interface InboxState {
  /**
   * The latest owner-signed inbox key (null: the workspace has no inbox, or none is known yet
   * when `problem` is set).
   */
  readonly inboxKey: SignedInboxKey | null;
  /** Whether this connection may file clips (read-write, a vouched key, the inbox in scope). */
  readonly mayFile: boolean;
  /** The last filing pass's result, if one ran. */
  readonly filed: FileClipsResult | null;
  /**
   * Why this is the last known state rather than a fresh one: `syncing` (the workspace isn't
   * ready yet), `unreachable` (the inbox key couldn't be read), `slow` (the pass took too long to
   * wait for), `untrusted` (the inbox key isn't the owner's) or `rollback` (an older inbox key
   * than one this device verified). Null for a fresh one.
   */
  readonly problem: InboxProblem | null;
}

/** Why an `InboxState` isn't fresh. */
export type InboxProblem = "syncing" | "unreachable" | "slow" | "untrusted" | "rollback";

const NO_INBOX_STATE: InboxState = { inboxKey: null, mayFile: false, filed: null, problem: null };

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
  /** The filing passes running now, if any (the web clipper; one at a time). */
  private filing: Promise<InboxState> | undefined;
  /** Whether a call came in during the running pass, which then runs once more. */
  private fileAgain = false;
  /** The last inbox state read while ready, for answers when no fresh one can be had. */
  private lastInbox: InboxState = NO_INBOX_STATE;
  /** The token's scope this session acts on (see `SessionScope`). */
  private currentScope: SessionScope;
  /** The scope read running now, if any (concurrent callers share it). */
  private scopeRead: Promise<void> | undefined;
  /** A call came in while a read ran (read once more), and whether any caller asked to pull. */
  private scopeAgain = false;
  private scopePull = false;
  /** Who wants to know when the scope changes (the MCP server's tool list). */
  private readonly scopeListeners = new Set<() => void>();

  private constructor(
    readonly connection: Connection,
    private readonly deps: SessionDeps,
    private readonly ownerKey: Uint8Array,
    floor: AgentScopeFloor | undefined,
  ) {
    this.currentScope = floor === undefined ? connectScope(connection) : verifiedScope(floor);
    const scopeFolders = this.currentScope.folderIds;
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
        : { agent: { tokenId: connection.tokenId, signing, folderIds: scopeFolders } }),
    });
    this.view = new WorkspaceView(this.engine, scopeFolders, connection.ownerId);
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
    // the owner changed this token's scope: read it again (and pull again if its reach moved)
    this.engine.on("scope_changed", () => {
      void this.refreshScope({ pull: true });
    });
  }

  /**
   * A session for a saved connection; the owner key is the pinned one, never the server's. The
   * token's scope floor (`agent-scopes.enc`) is verified again under that key before it counts.
   */
  static async open(connection: Connection, deps: SessionDeps): Promise<WorkspaceSession> {
    const pinned = await deps.trust.ownerKey(connection.workspaceId);
    const ownerKey = pinned ?? fromBase64Url(connection.ownerSignPublicKey);
    let floor: AgentScopeFloor | undefined;
    try {
      floor = await deps.scopes?.scopeFloor(connection.workspaceId, connection.tokenId);
    } catch {
      floor = undefined;
    }
    if (floor !== undefined) {
      const checked = await verifyAgentScope(floor.signed, {
        ownerSigningPublicKey: ownerKey,
        accountId: connection.ownerId,
        workspaceId: connection.workspaceId,
        tokenId: connection.tokenId,
      });
      if (!checked.ok || checked.revision !== floor.revision) floor = undefined;
    }
    return new WorkspaceSession(connection, deps, ownerKey, floor);
  }

  /** The token's scope this session acts on (see `SessionScope`). */
  get scope(): SessionScope {
    return this.currentScope;
  }

  /** The token's permissions, from its verified scope (none at revision 0). */
  get permissions(): readonly AgentPermission[] {
    return this.currentScope.permissions;
  }

  /** Whether the verified scope holds a permission, with `read-write`. */
  allows(permission: AgentPermission): boolean {
    return agentScopeAllows(this.currentScope, permission);
  }

  /** Calls `listener` whenever the scope changes; returns the function that stops it. */
  onScopeChange(listener: () => void): () => void {
    this.scopeListeners.add(listener);
    return () => {
      this.scopeListeners.delete(listener);
    };
  }

  /**
   * Reads the token again (`getCurrentToken`, one short attempt) and verifies its signed scope
   * under the pinned owner key, at or above the floor (the highest revision verified before, kept
   * in `agent-scopes.enc`): a verified one becomes the scope and the floor; a refused one keeps
   * the last verified scope (`problem` says why); a token at revision 0 keeps the access and
   * folders saved at connect. Only when the access or folders changed is the local copy dropped
   * (`SyncEngine.reset`), and pulled again from version 0 when `pull` (else the next sync does);
   * a change of permissions alone needs no pull. `credentials.enc` stays as written at connect.
   * Runs at start, on `scope_changed` and once after `scope_denied`, `permission_required` or
   * `stale_agent_scope`. A call while a read runs joins it and has it read once more after (its
   * `pull` counts too), so a scope changed meanwhile isn't missed. Never rejects.
   */
  refreshScope(options: { readonly pull?: boolean } = {}): Promise<void> {
    if (options.pull === true) this.scopePull = true;
    // a call while a read runs: what it answers may already be stale, so read once more after
    if (this.scopeRead !== undefined) {
      this.scopeAgain = true;
      return this.scopeRead;
    }
    const reads = async () => {
      let reset = false;
      do {
        this.scopeAgain = false;
        if (await this.readScope()) reset = true;
      } while (this.readScopeAgain());
      const pull = this.scopePull;
      this.scopePull = false;
      if (reset && pull) await this.sync();
    };
    const read = reads().finally(() => {
      if (this.scopeRead === read) this.scopeRead = undefined;
    });
    this.scopeRead = read;
    return read;
  }

  /** Whether a call came in during the last scope read, so it reads once more. */
  private readScopeAgain(): boolean {
    return this.scopeAgain && !this.ended;
  }

  /** Reads and checks the token's scope once; true when it dropped the local copy. */
  private async readScope(): Promise<boolean> {
    if (this.ended) return false;
    let token;
    try {
      ({
        data: { token },
      } = await this.policyApi.call(routes.getCurrentToken));
    } catch {
      // offline or refused: the last verified scope stays; the sync says why
      return false;
    }
    const before = this.currentScope;
    const floor = before.verified ? before.revision : 0;
    const checked = await verifyAgentScope(token.scope, {
      ownerSigningPublicKey: this.ownerKey,
      accountId: this.connection.ownerId,
      workspaceId: this.workspaceId,
      tokenId: this.connection.tokenId,
      minRevision: floor,
      // the scope kept at the floor: the same one again, or the next chained to it
      ...(before.scopeSha256 === null ? {} : { floorScopeSha256: before.scopeSha256 }),
    });
    if (!checked.ok) {
      this.setScope({ ...before, problem: checked.problem });
      return false;
    }
    const verified = checked.verified;
    const next =
      verified === null
        ? connectScope(this.connection)
        : verifiedScope({ revision: verified.revision, signed: verified.signed });
    if (verified !== null) {
      await this.deps.scopes
        ?.putScopeFloor({
          workspaceId: this.workspaceId,
          tokenId: this.connection.tokenId,
          revision: verified.revision,
          signed: verified.signed,
        })
        .catch(() => undefined);
    }
    const moved = reachChanged(before, next);
    this.setScope(next);
    if (!moved) return false;
    this.engine.setAgentFolderIds(next.folderIds);
    this.view.setScope(next.folderIds);
    this.lastPolicyAt = Number.NEGATIVE_INFINITY;
    try {
      await this.engine.reset();
      this.loaded = false;
    } catch {
      // the engine stopped (revoked): nothing to pull
      return false;
    }
    return true;
  }

  private setScope(scope: SessionScope): void {
    this.currentScope = scope;
    for (const listener of [...this.scopeListeners]) {
      try {
        listener();
      } catch {
        // a broken listener must not break the session
      }
    }
  }

  get workspaceId(): WorkspaceId {
    return this.connection.workspaceId;
  }

  /** Whether the token may change notes (propose, or write directly), by its verified scope. */
  get writable(): boolean {
    return this.currentScope.access === "read-write";
  }

  /**
   * Whether this connection may write directly where the workspace allows it: it may write, has
   * its own signing key and the owner vouched for it at connect. Otherwise it only proposes.
   */
  get writesDirectly(): boolean {
    return this.writable && hasVouchedKey(this.connection);
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
        scopeFolderIds: this.currentScope.folderIds,
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

  /** The actor of the clips filed in the background. */
  private actor(): Actor {
    return this.deps.actor?.() ?? "knowtarium-cli/0";
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
      // the token's scope first: a reach that changed drops the copy before the pull
      await this.refreshScope();
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
      "This workspace was disconnected on this computer (`npx knowtarium disconnect`); connect it again with `npx knowtarium connect` from your home folder, then restart the agent.",
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
      // the web clipper's clips, where this connection may file them: in the background, so
      // nothing waiting on this sync (the first sync, a tool's retry) waits on the filing too
      if (this.filesInBackground) void this.fileClips();
      await this.saveIndex();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Reads the inbox key (the web clipper) and, when this connection may file clips (a
   * `read-write` token whose signing key the owner vouched for, with the inbox folder in its
   * scope), files the waiting ones into existing folders where agents' changes apply directly,
   * for at most `maxMs` a pass; the rest wait for the web app, with the reason. One pass at a
   * time: a call while one runs (a `clip_added` ping, say) joins it and has it run once more
   * when it ends, so a clip queued meanwhile isn't left for the next sync. Never rejects: a
   * failure leaves `filed` null.
   */
  fileClips(maxMs = CLIP_FILING_MAX_MS): Promise<InboxState> {
    if (this.filing !== undefined) {
      this.fileAgain = true;
      return this.filing;
    }
    const passes = async (): Promise<InboxState> => {
      for (;;) {
        this.fileAgain = false;
        const state = await this.filePass(maxMs);
        if (!this.anotherPass()) return state;
      }
    };
    const filing = passes().finally(() => {
      if (this.filing === filing) this.filing = undefined;
    });
    this.filing = filing;
    return filing;
  }

  /**
   * Whether this connection files clips in the background (after a sync, on `clip_added`): only a
   * `read-write` token whose signing key the owner vouched for; any other only reads the inbox
   * key when `list_inbox` asks.
   */
  private get filesInBackground(): boolean {
    return this.writable && this.writesDirectly;
  }

  /** Settles when the filing passes running now end (at once when none runs); starts none. */
  async filingDone(): Promise<void> {
    await this.filing;
  }

  /**
   * The inbox state for `list_inbox`: a filing pass (see `fileClips`), waited for at most
   * `CLIP_FILING_MAX_MS` and a second; past that, the last known state (`slow`). Never rejects.
   */
  async inbox(): Promise<InboxState> {
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<InboxState>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ...this.lastInbox, problem: "slow" });
      }, CLIP_FILING_MAX_MS + 1_000);
      timer.unref();
    });
    try {
      return await Promise.race([this.fileClips(), slow]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * How many clips wait in the queue, read with one short attempt; null when this connection
   * can't see the queue (read-only, or the inbox outside its folders) or the API doesn't answer.
   */
  async waitingClips(): Promise<number | null> {
    if (!this.writable || this.status !== "ready") return null;
    try {
      const { data } = await this.policyApi.call(routes.clipSummary, {
        params: { workspaceId: this.workspaceId },
      });
      return data.pending;
    } catch {
      return null;
    }
  }

  /** Whether a call came in during the last pass, so another runs. */
  private anotherPass(): boolean {
    return this.fileAgain && !this.ended;
  }

  private async filePass(maxMs: number): Promise<InboxState> {
    // never on an API still being synced with, unreachable or failed: the last known state
    if (this.status !== "ready") return { ...this.lastInbox, problem: "syncing" };
    let inboxKey: SignedInboxKey | null;
    try {
      // one short attempt: list_inbox waits on it
      inboxKey = await fetchInboxKey(this.policyApi, {
        workspaceId: this.workspaceId,
        owner: { publicKey: this.ownerKey, accountId: this.connection.ownerId },
        trust: this.deps.trust,
      });
    } catch (error) {
      const problem: InboxProblem = isVaultError(error, "rollback")
        ? "rollback"
        : isVaultError(error, "untrusted_signature")
          ? "untrusted"
          : "unreachable";
      return { ...this.lastInbox, problem };
    }
    const state = await this.fileWith(inboxKey, maxMs);
    this.lastInbox = state;
    return state;
  }

  private async fileWith(inboxKey: SignedInboxKey | null, maxMs: number): Promise<InboxState> {
    const mayFile =
      inboxKey !== null &&
      !this.ended &&
      this.writable &&
      this.writesDirectly &&
      this.view.folders.has(inboxKey.envelope.folderId) &&
      this.inScope(inboxKey.envelope.folderId);
    if (!mayFile) return { inboxKey, mayFile, filed: null, problem: null };
    const folders = new Map<FolderId, ClipFolder>(
      [...this.view.folders].map(([id, folder]) => [
        id,
        { name: folder.name, parentId: folder.parentId },
      ]),
    );
    const started = this.now();
    const actor = this.actor();
    try {
      const filed = await this.engine.fileClips({
        folders,
        takenNames: (folderId) =>
          [...this.view.notes.values()]
            .filter((note) => note.folderId === folderId && note.name !== null)
            .map((note) => note.name ?? ""),
        stamp: (text, _folderId, at) => setGenerated(parseNote(text), actor, at).text,
        actor,
        agentWrite: {
          minPolicyRevision: this.policyFloor,
          visibleFolderIds: [...this.view.folders.keys()],
        },
        deadline: started + maxMs,
        now: () => this.now(),
      });
      return { inboxKey, mayFile, filed, problem: null };
    } catch {
      return { inboxKey, mayFile, filed: null, problem: null };
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

  /** Keeps the cache fresh while the server runs: live pings start pulls (and file clips). */
  goLive(connect: SocketFactory): void {
    if (this.ended) return;
    this.engine.on("synced", () => {
      void this.refreshChecks()
        .then(() => this.saveIndex())
        .catch(() => undefined);
    });
    this.engine.on("clip_added", () => {
      if (this.filesInBackground) void this.fileClips();
    });
    // every (re)connect reads the scope again: a change made while the socket was down (asleep,
    // offline, or closed after a first scope_changed) sends no ping of its own
    this.engine.on("live", ({ state }) => {
      if (state === "open") void this.refreshScope({ pull: true });
    });
    this.engine.connectLive(connect, {
      onClose: (code) => {
        if (code === STALE_CLOSE_CODE) void this.refreshScope({ pull: true });
      },
    });
  }

  /** Stops syncing (the server is shutting down). */
  stop(): void {
    clearTimeout(this.retry);
    this.engine.stop();
  }

  /**
   * The clipper's inbox folder as the last verified inbox key named it (agents may not delete
   * it); null when none was read.
   */
  get inboxFolderId(): FolderId | null {
    return this.lastInbox.inboxKey?.envelope.folderId ?? null;
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
  return `This agent's access to workspace ${workspaceId} was revoked (in the web app, or its account was deleted), so this connection can't be used any more. To remove it from this computer, run \`${disconnectCommandFor(workspaceId)}\`; to keep using the workspace, run \`npx knowtarium connect\` from your home folder to connect it again. Then restart the agent.`;
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
        return "This agent's access was revoked. Run `npx knowtarium connect` from your home folder to connect again, then restart the agent so it picks up the new connection.";
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
