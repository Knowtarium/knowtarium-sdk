// An in-memory sync API for the client tests: the routes the sync engine uses, with the checks
// the real server makes (protocol and CSRF headers, auth mode, base versions, and every signed
// envelope rebuilt from the request and verified against the owner's key). Not exported.
import {
  ciphertextSha256,
  fromBase64Url,
  recipientsHash,
  type SignedEnvelopeFields,
  toBase64Url,
  verifyEnvelope,
} from "../../crypto/index.js";
import { utf8Decode, utf8Encode } from "../../crypto/encoding.js";
import {
  type AccountId,
  type AgentToken,
  attachmentChunkCountFits,
  ENVELOPE_OVERHEAD_BYTES,
  LIMITS,
  type Attachment,
  type AttachmentId,
  type ChangeEntry,
  type CheckId,
  type CheckRecord,
  type CommentId,
  type EventId,
  type ErrorCode,
  ERROR_STATUS,
  type FolderId,
  formatId,
  type IdPrefix,
  type NoteComment,
  type NoteEvent,
  type NoteId,
  type NoteMeta,
  type NoteVersion,
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_PLAN,
  HISTORY_AGE_BUCKET_DAYS,
  HISTORY_RETENTION_DAYS,
  type HistoryAmount,
  type HistoryBreakdown,
  isHistoryRetentionDays,
  type PendingChange,
  type PendingId,
  ROUTE_LIST,
  SIGNATURE_MAX_SKEW_SECONDS,
  type RouteName,
  type TokenId,
  type WorkspaceId,
  type KeyRecipient,
  type TokenRevocation,
  type WrappedWorkspaceKey,
  isSupportedProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type AgentKeyRecord,
  type AgentPolicy,
  type AgentPolicyFolder,
  type AgentPolicyFolderLookup,
  agentPolicyAncestry,
  agentPolicySha256,
  agentPolicyViewFor,
  effectiveMode,
  MISSING_AGENT_POLICY_SHA256,
  missingAgentPolicy,
  type AgentWriteMode,
} from "../../protocol/index.js";
import type { FetchInit, FetchLike, FetchResponse } from "../platform/fetch.js";
import { type RecordedCall, response } from "./http.js";

interface NoteVersionRow {
  readonly version: number;
  /** Null for a delete marker, and once the content was removed after the history period. */
  blob: Uint8Array | null;
  readonly sizeBytes: number;
  readonly deleted: boolean;
  readonly authorId: AccountId | TokenId;
  readonly createdAt: string;
  readonly fromPendingId: PendingId | null;
  /** When the content was removed after the history period (`pruneVersion`). */
  prunedAt: string | null;
}

/** A superseded version that still has its content, with its age in days. */
interface OlderVersion {
  readonly noteId: NoteId;
  readonly entry: NoteVersionRow;
  readonly age: number;
  /** Kept whatever its age: an open pending change's base, or what an undo brings back. */
  readonly protected: boolean;
}

interface NoteRow {
  folderId: FolderId;
  readonly versions: NoteVersionRow[];
}

interface Request {
  readonly name: RouteName;
  readonly params: Record<string, string>;
  readonly query: URLSearchParamsLike;
  readonly headers: Map<string, string>;
  readonly body: Uint8Array | undefined;
  readonly caller: "session" | "agent";
}

interface URLSearchParamsLike {
  get(name: string): string | null;
}

class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

/** An `invalid_request` with one issue, as the sync API words it. */
function invalid(at: readonly (string | number)[], problem: string): HttpError {
  return new HttpError("invalid_request", { issues: [{ at, problem }] });
}

export interface FakeServerOptions {
  readonly workspaceId: WorkspaceId;
  readonly ownerId: AccountId;
  readonly ownerSigningPublicKey: Uint8Array;
  readonly ownerBoxPublicKey: Uint8Array;
  readonly tokenId: TokenId;
  readonly agentToken: string;
  /** The agent's X25519 public key, as `getCurrentToken` reports it. */
  readonly agentPublicKey?: Uint8Array;
  readonly encName: string;
  readonly keyGeneration: number;
  readonly sessionKeys: WrappedWorkspaceKey[];
  readonly agentKeys: WrappedWorkspaceKey[];
}

/** One page of the changes feed. */
export interface ChangesPage {
  readonly workspaceVersion: number;
  readonly changes: ChangeEntry[];
  readonly hasMore: boolean;
}

/** Ways a test makes the server misbehave. */
export interface Tampering {
  /** Replaces the bytes served for a note version. */
  versionBlob?: (noteId: NoteId, version: number, blob: Uint8Array) => Uint8Array;
  /** Rewrites the changes feed. */
  feed?: (changes: ChangeEntry[]) => ChangeEntry[];
  /** Rewrites the events list. */
  events?: (events: NoteEvent[]) => NoteEvent[];
  /** Rewrites what a note write, delete or approval says it stored. */
  stored?: (answer: { note: NoteMeta; event: NoteEvent }) => { note: NoteMeta; event: NoteEvent };
  /** Rewrites a whole page of the changes feed. */
  changesPage?: (page: ChangesPage) => ChangesPage;
  /** Answers a route with this error code instead of handling it. */
  refuse?: (route: RouteName) => ErrorCode | undefined;
  /** Rewrites a note's versions list. */
  versions?: (versions: NoteVersion[]) => NoteVersion[];
  /** Rewrites the agent policy `getAgentPolicy` answers (after building an agent's view). */
  agentPolicy?: (policy: AgentPolicy) => AgentPolicy;
  /** Holds a route's answer (already computed) until the promise settles. */
  hold?: (route: RouteName) => Promise<void> | undefined;
  /** Rewrites the `ETag` of every answer that has one, as an edge proxy might. */
  etag?: (tag: string) => string;
}

/** The answer with its `ETag` rewritten. */
function retagged(answer: FetchResponse, etag: (tag: string) => string): FetchResponse {
  return {
    ...answer,
    headers: {
      get: (name) => {
        const value = answer.headers.get(name);
        return value !== null && name.toLowerCase() === "etag" ? etag(value) : value;
      },
    },
  };
}

function parseQuery(search: string): URLSearchParamsLike {
  const values = new Map<string, string>();
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (pair === "") continue;
    const [key = "", value = ""] = pair.split("=");
    values.set(decodeURIComponent(key), decodeURIComponent(value));
  }
  return { get: (name) => values.get(name) ?? null };
}

function templateRegex(path: string): RegExp {
  return new RegExp(`^${path.replace(/:([A-Za-z]+)/g, "(?<$1>[^/]+)")}$`);
}

const MATCHERS = ROUTE_LIST.map((route) => ({ route, regex: templateRegex(route.path) }));

export class FakeServer {
  /** Every request, as sent. */
  readonly requests: RecordedCall[] = [];
  readonly tamper: Tampering = {};
  seq = 0;
  readonly notes = new Map<NoteId, NoteRow>();
  readonly events: NoteEvent[] = [];
  readonly pending = new Map<PendingId, { change: PendingChange; blob: Uint8Array }>();
  readonly comments: NoteComment[] = [];
  readonly checks: CheckRecord[] = [];
  readonly changes = new Map<string, ChangeEntry>();
  readonly folders = new Map<FolderId, { parentId: FolderId | null; encName: string }>();
  /** Attachments by id, with the chunks stored so far. */
  readonly attachments = new Map<AttachmentId, { attachment: Attachment; chunks: Uint8Array[] }>();
  /** The storage attachments count against, in bytes (lower it to test a full workspace). */
  quotaBytes = Number.MAX_SAFE_INTEGER;
  sessionKeys: WrappedWorkspaceKey[];
  agentKeys: WrappedWorkspaceKey[];
  keyGeneration: number;
  tickets = 0;
  /** Whether the agent token was revoked. */
  tokenRevoked = false;
  /**
   * The agent token's folders, enforced like the sync API: each folder's subtree (a folder with
   * no parent is at the top level, so the root folder's subtree is only its own notes). Empty
   * means the whole workspace.
   */
  agentFolderIds: FolderId[] = [];
  /** The agent token's access; a `read` token may neither write nor propose. */
  agentAccess: "read" | "read-write" = "read-write";
  /** Folders marked deleted, as the agent policy's ancestry reads them. */
  readonly deletedFolders = new Set<FolderId>();
  /** The most direct writes an agent may make a day (the sync API's cap); then 429. */
  agentWriteDailyCap = Number.POSITIVE_INFINITY;
  /** How many direct writes the agent made (the fake's day never ends). */
  agentWrites = 0;
  /** Agent-write signatures already used: a replay is refused. */
  private readonly usedAgentSignatures = new Set<string>();
  /**
   * Vouched agent keys of the owner's other workspaces: an owner session's `listKeys` lists
   * them too, as the sync API does for every workspace the account owns.
   */
  readonly otherWorkspaceAgentKeys: AgentKeyRecord[] = [];
  /** When the agent token was revoked, as `listKeys` marks its copies. */
  tokenRevokedAt: string | null = null;
  /** The owner-signed revocations `revokeToken` received. */
  readonly revocations: TokenRevocation[] = [];
  /** The vouched agent signing keys (`listKeys` `agentKeys`); push a forged one to test. */
  readonly agentKeyRecords: AgentKeyRecord[] = [];
  /** The workspace's history period, in days (`setHistorySettings` changes it). */
  historyRetentionDays: number = DEFAULT_HISTORY_RETENTION_DAYS;
  /** When the cleanup last ran: every pass, even one that freed nothing (null: never yet). */
  historyCleanupAt: string | null = null;
  /** The agent token's signing public key as stored at connect (null: a legacy token). */
  agentSignPublicKey: Uint8Array | null = null;
  /** Every agent policy revision from 1 on, oldest first (revision 0 is the missing policy). */
  readonly agentPolicies: AgentPolicy[] = [];
  /** How many key rotations were stored. */
  rotations = 0;
  /** How many `getVersions` requests came in. */
  versionBatches = 0;
  /** The byte cap of one `getVersions` answer (lower it to test the cap). */
  versionBatchBytes = 16 * 1024 * 1024;
  /** The bodies of `replaceRecoveryKey` calls, as received. */
  readonly recoveryKeyReplacements: Record<string, unknown>[] = [];
  /** Connect requests by ID, with what a poll answers. */
  readonly connectRequests = new Map<
    string,
    { pollSecret: string; status: "pending" | "approved" | "denied" | "expired"; relay?: string }
  >();
  private counter = 0;

  constructor(private readonly options: FakeServerOptions) {
    this.sessionKeys = options.sessionKeys;
    this.agentKeys = options.agentKeys;
    this.keyGeneration = options.keyGeneration;
    this.recordChange("workspace", {
      kind: "workspace",
      seq: this.bump(),
      at: new Date().toISOString(),
      encName: options.encName,
      keyGeneration: options.keyGeneration,
    });
  }

  /** The `fetch` the API client gets. */
  readonly fetch: FetchLike = (url, init) => {
    this.requests.push({ url, init });
    const failed = (error: unknown): FetchResponse => {
      if (!(error instanceof HttpError))
        throw error instanceof Error ? error : new Error(String(error));
      const status = ERROR_STATUS[error.code];
      return response(
        status,
        { error: { code: error.code, message: error.code, ...error.extra } },
        error.headers,
      );
    };
    let answer: FetchResponse | Promise<FetchResponse>;
    try {
      answer = this.handle(url, init);
    } catch (error) {
      try {
        answer = failed(error);
      } catch (thrown) {
        return Promise.reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
      }
    }
    // the agent policy routes hash with Web Crypto, so they answer asynchronously
    const settled = (
      answer instanceof Promise ? answer.catch(failed) : Promise.resolve(answer)
    ).then((done) => {
      const etag = this.tamper.etag;
      return etag === undefined ? done : retagged(done, etag);
    });
    const held = this.lastRoute === undefined ? undefined : this.tamper.hold?.(this.lastRoute);
    return held === undefined ? settled : held.then(() => settled);
  };

  private lastRoute: RouteName | undefined;

  private id<P extends IdPrefix>(prefix: P): `${P}_${string}` {
    this.counter++;
    const bytes = new Uint8Array(16);
    bytes[15] = this.counter & 0xff;
    bytes[14] = (this.counter >> 8) & 0xff;
    return formatId(prefix, bytes);
  }

  private bump(): number {
    this.seq++;
    return this.seq;
  }

  private recordChange(key: string, change: ChangeEntry): void {
    this.changes.delete(key);
    this.changes.set(key, change);
  }

  private handle(url: string, init: FetchInit): FetchResponse | Promise<FetchResponse> {
    const parsed = /^https?:\/\/[^/]+(?<path>[^?]*)(?<search>\?.*)?$/.exec(url);
    const path = parsed?.groups?.["path"] ?? "";
    const headers = new Map(
      Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    if (!isSupportedProtocolVersion(headers.get("knowtarium-protocol-version"))) {
      throw new HttpError("unsupported_protocol", {
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      });
    }
    if (init.method !== "GET" && headers.get("knowtarium-request") !== "1") {
      throw new HttpError("forbidden");
    }
    const match = MATCHERS.find(
      ({ route, regex }) => route.method === init.method && regex.test(path),
    );
    if (match === undefined) throw new HttpError("not_found");
    const params = { ...(match.regex.exec(path)?.groups ?? {}) };
    const bearer = headers.get("authorization");
    let caller: "session" | "agent";
    if (bearer !== undefined) {
      if (bearer !== `Bearer ${this.options.agentToken}`) throw new HttpError("unauthenticated");
      if (this.tokenRevoked) throw new HttpError("token_revoked");
      caller = "agent";
    } else if (init.credentials === "include") caller = "session";
    else throw new HttpError("unauthenticated");
    if (match.route.auth === "session" && caller !== "session") throw new HttpError("forbidden");
    if (match.route.auth === "agent" && caller !== "agent") throw new HttpError("forbidden");
    const body =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? utf8Encode(init.body)
          : init.body;
    this.lastRoute = match.route.name;
    const refusal = this.tamper.refuse?.(match.route.name);
    if (refusal !== undefined) throw new HttpError(refusal);
    const request: Request = {
      name: match.route.name,
      params,
      query: parseQuery(parsed?.groups?.["search"] ?? ""),
      headers,
      body,
      caller,
    };
    this.checkScope(request);
    return this.route(request);
  }

  private json(request: Request): Record<string, unknown> {
    return JSON.parse(utf8Decode(request.body ?? new Uint8Array())) as Record<string, unknown>;
  }

  /**
   * Verifies a signature as the server does: over the envelope rebuilt from the request with the
   * session's own account as signer (so a signature by any other account fails), with
   * `createdAt` within the allowed clock skew.
   */
  private verify(
    fields: SignedEnvelopeFields,
    signature: string | undefined,
    publicKey: Uint8Array = this.options.ownerSigningPublicKey,
  ): void {
    if (signature === undefined) throw new HttpError("signature_required");
    if (fields.accountId !== this.options.ownerId) throw new HttpError("invalid_signature");
    const skew = Math.abs(Date.parse(fields.createdAt) - Date.now());
    if (!(skew <= SIGNATURE_MAX_SKEW_SECONDS * 1000)) throw new HttpError("invalid_signature");
    const clean = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as unknown as SignedEnvelopeFields;
    const ok = verifyEnvelope({ version: 1, envelope: clean, signature }, publicKey);
    if (!ok) throw new HttpError("invalid_signature");
  }

  /** The current agent policy (revision 0 is the missing policy). */
  get agentPolicy(): AgentPolicy {
    return this.agentPolicies.at(-1) ?? missingAgentPolicy();
  }

  /** The folder tree as `agentPolicyAncestry` reads it (the server knows every folder). */
  private readonly folderLookup: AgentPolicyFolderLookup = (folderId) => {
    const folder = this.folders.get(folderId as FolderId);
    return folder === undefined
      ? undefined
      : { parentId: folder.parentId, deleted: this.deletedFolders.has(folderId as FolderId) };
  };

  /**
   * Vouches for the agent's signing key as `approveConnect` does: rebuilds `agent_key` with the
   * token, the key and the server's current policy revision, verifies the owner's signature and
   * stores the record (`listKeys` `agentKeys`). A policy change since signing fails it.
   */
  vouchAgentKey(fields: {
    readonly signPublicKey: string;
    readonly agentKeySignedAt: string;
    readonly agentKeySignature: string;
  }): void {
    const envelope: SignedEnvelopeFields = {
      type: "agent_key",
      accountId: this.options.ownerId,
      workspaceId: this.options.workspaceId,
      tokenId: this.options.tokenId,
      signPublicKey: fields.signPublicKey,
      policyRevision: this.agentPolicy.revision,
      createdAt: fields.agentKeySignedAt,
    };
    try {
      this.verify(envelope, fields.agentKeySignature);
    } catch (error) {
      // signed over an older revision: the policy moved since the owner read it
      const older = Array.from({ length: this.agentPolicy.revision }, (_, revision) => revision);
      const stale = older.some((policyRevision) => {
        try {
          this.verify({ ...envelope, policyRevision }, fields.agentKeySignature);
          return true;
        } catch {
          return false;
        }
      });
      throw stale ? new HttpError("stale_agent_policy") : error;
    }
    this.agentSignPublicKey = fromBase64Url(fields.signPublicKey);
    this.agentKeyRecords.push({
      signed: { envelope, signature: fields.agentKeySignature } as AgentKeyRecord["signed"],
      revokedAt: null,
    });
  }

  /**
   * Removes a version's content as the history cleanup does: the row and its signed event stay,
   * the blob goes. Refuses a note's current version (the cleanup never removes it).
   */
  pruneVersion(noteId: NoteId, version: number, at = new Date().toISOString()): void {
    const row = this.notes.get(noteId);
    const entry = row?.versions.find((candidate) => candidate.version === version);
    if (row === undefined || entry === undefined || entry.deleted) {
      throw new Error("no stored version to prune");
    }
    if (entry === row.versions.at(-1)) throw new Error("the current version is never pruned");
    entry.blob = null;
    entry.prunedAt = at;
  }

  /**
   * Every stored, superseded version with content (never a current version or a delete marker),
   * with its age in days (since the next version came) and whether the cleanup must keep it, as
   * the sync API decides: the base of an open pending change, and the version before the current
   * one when that is an agent's direct write (what undo brings back).
   */
  private olderVersions(now: number): OlderVersion[] {
    const older: OlderVersion[] = [];
    const openBases = new Set(
      [...this.pending.values()]
        .filter(({ change }) => change.status === "open")
        .map(({ change }) => `${change.noteId}:${String(change.baseVersion)}`),
    );
    for (const [noteId, row] of this.notes) {
      const current = row.versions.at(-1);
      const agentOnTop =
        current !== undefined &&
        !current.authorId.startsWith("acc_") &&
        current.fromPendingId === null;
      row.versions.forEach((entry, index) => {
        const next = row.versions[index + 1];
        if (next === undefined || entry.blob === null || entry.deleted) return;
        older.push({
          noteId,
          entry,
          age: (now - Date.parse(next.createdAt)) / 86_400_000,
          protected:
            openBases.has(`${noteId}:${String(entry.version)}`) ||
            (agentOnTop && entry.version === current.version - 1),
        });
      });
    }
    return older;
  }

  /** The history breakdown as the sync API answers it, protected versions apart. */
  private historyBreakdown(now: number): HistoryBreakdown {
    const buckets = HISTORY_AGE_BUCKET_DAYS.map((minAgeDays) => ({
      minAgeDays,
      versions: 0,
      bytes: 0,
    }));
    const kept: HistoryAmount = { versions: 0, bytes: 0 };
    for (const { entry, age, protected: isProtected } of this.olderVersions(now)) {
      if (isProtected) {
        kept.versions += 1;
        kept.bytes += entry.sizeBytes;
        continue;
      }
      const bucket = buckets.findLast((candidate) => age >= candidate.minAgeDays);
      if (bucket === undefined) continue;
      bucket.versions += 1;
      bucket.bytes += entry.sizeBytes;
    }
    let current = 0;
    for (const row of this.notes.values()) current += row.versions.at(-1)?.sizeBytes ?? 0;
    return { buckets, protected: kept, current: { bytes: current } };
  }

  /** The history routes: the owner's settings and an agent's read of the period. */
  private routeHistorySettings(request: Request): FetchResponse | undefined {
    const now = Date.now();
    switch (request.name) {
      case "getHistoryRetention":
        return response(200, { retentionDays: this.historyRetentionDays });
      case "getHistorySettings": {
        const breakdown = this.historyBreakdown(now);
        let usedBytes = breakdown.current.bytes;
        for (const bucket of breakdown.buckets) usedBytes += bucket.bytes;
        return response(200, {
          retentionDays: this.historyRetentionDays,
          lastCleanupAt: this.historyCleanupAt,
          breakdown,
          usage: {
            usedBytes,
            quotaBytes: DEFAULT_PLAN.storageQuotaBytes,
            workspaceCount: 1,
            maxWorkspaces: DEFAULT_PLAN.maxWorkspaces,
          },
        });
      }
      case "setHistorySettings": {
        // as the sync API: only the protocol's steps; a shorter period runs a cleanup pass at
        // once (versions superseded at least that many days ago, protected ones kept), a longer
        // or equal one runs none
        const { retentionDays } = this.json(request);
        if (!isHistoryRetentionDays(retentionDays)) {
          throw invalid(
            ["retentionDays"],
            `Expected one of ${HISTORY_RETENTION_DAYS.join(", ")} days`,
          );
        }
        const before = this.historyRetentionDays;
        this.historyRetentionDays = retentionDays;
        const freed: HistoryAmount = { versions: 0, bytes: 0 };
        if (retentionDays < before) {
          const at = new Date(now).toISOString();
          for (const { noteId, entry, age, protected: isProtected } of this.olderVersions(now)) {
            if (isProtected || age < retentionDays) continue;
            this.pruneVersion(noteId, entry.version, at);
            freed.versions += 1;
            freed.bytes += entry.sizeBytes;
          }
          this.historyCleanupAt = at;
        }
        return response(200, { retentionDays, freed, more: false });
      }
      default:
        return undefined;
    }
  }

  private currentVersion(noteId: NoteId): number {
    return this.notes.get(noteId)?.versions.at(-1)?.version ?? 0;
  }

  private noteMeta(noteId: NoteId): NoteMeta {
    const row = this.notes.get(noteId);
    const last = row?.versions.at(-1);
    if (row === undefined || last === undefined) throw new HttpError("not_found");
    return {
      id: noteId,
      workspaceId: this.options.workspaceId,
      folderId: row.folderId,
      currentVersion: last.version,
      sizeBytes: last.sizeBytes,
      updatedAt: last.createdAt,
      updatedBy: last.authorId,
      createdAt: row.versions[0]?.createdAt ?? last.createdAt,
      deleted: last.deleted,
    };
  }

  /**
   * Stores a signed version (or delete marker) with its event and feed entry: a person's, or an
   * agent's direct write (`byAgent`, authored by the token).
   */
  private storeVersion(
    noteId: NoteId,
    folderId: FolderId,
    blob: Uint8Array | null,
    signed: { envelope: SignedEnvelopeFields; signature: string },
    fromPendingId: PendingId | null,
    byAgent = false,
  ): { note: NoteMeta; event: NoteEvent; workspaceVersion: number } {
    const seq = this.bump();
    const createdAt = new Date().toISOString();
    const version = this.currentVersion(noteId) + 1;
    const row = this.notes.get(noteId) ?? { folderId, versions: [] };
    const authorId = byAgent ? this.options.tokenId : this.options.ownerId;
    row.folderId = folderId;
    row.versions.push({
      version,
      blob,
      sizeBytes: blob?.length ?? 0,
      deleted: blob === null,
      authorId,
      createdAt,
      fromPendingId,
      prunedAt: null,
    });
    this.notes.set(noteId, row);
    const event: NoteEvent = {
      id: this.id("evt"),
      workspaceId: this.options.workspaceId,
      noteId,
      noteVersion: version,
      authorId,
      authorTokenId: byAgent ? this.options.tokenId : null,
      createdAt,
      seq,
      ciphertext: null,
      signed: signed as NoteEvent["signed"],
    };
    this.events.push(event);
    this.recordChange(`note:${noteId}`, {
      kind: "note",
      seq,
      at: createdAt,
      noteId,
      folderId,
      version,
      sizeBytes: blob?.length ?? 0,
      authorId,
      deleted: blob === null,
      createdAt: row.versions[0]?.createdAt ?? createdAt,
    });
    const answer = { note: this.noteMeta(noteId), event };
    return { ...(this.tamper.stored?.(answer) ?? answer), workspaceVersion: seq };
  }

  /** The signing fields of a JSON body: required from a person, refused from an agent. */
  private bodySignature(
    request: Request,
    body: { signedAt?: string; signature?: string },
  ): { signedAt: string; signature: string } | null {
    if (request.caller === "agent") {
      if (body.signature !== undefined) throw new HttpError("forbidden");
      return null;
    }
    if (body.signature === undefined || body.signedAt === undefined) {
      throw new HttpError("signature_required");
    }
    return { signedAt: body.signedAt, signature: body.signature };
  }

  private actorOf(request: Request): AccountId | TokenId {
    return request.caller === "agent" ? this.options.tokenId : this.options.ownerId;
  }

  /** Versions, comments, check records and appended events. */
  private routeHistory(request: Request): FetchResponse {
    const workspaceId = this.options.workspaceId;
    const noteId = request.params["noteId"] as NoteId;
    const now = new Date().toISOString();
    switch (request.name) {
      case "listVersions": {
        const row = this.notes.get(noteId);
        if (row === undefined) throw new HttpError("not_found");
        const after = Number(request.query.get("since") ?? "0");
        const limit = Number(request.query.get("limit") ?? "1000");
        const all: NoteVersion[] = row.versions.map((entry) => ({
          noteId,
          version: entry.version,
          sizeBytes: entry.sizeBytes,
          authorId: entry.authorId,
          createdAt: entry.createdAt,
          deleted: entry.deleted,
          fromPendingId: entry.fromPendingId,
          pruned: entry.prunedAt !== null,
          prunedAt: entry.prunedAt,
        }));
        const listed = this.tamper.versions?.(all) ?? all;
        const later = listed.filter((entry) => entry.version > after);
        return response(200, { versions: later.slice(0, limit), hasMore: later.length > limit });
      }
      case "addComment": {
        const body = this.json(request) as {
          id: CommentId;
          noteId: NoteId;
          ciphertext: string;
          signedAt?: string;
          signature?: string;
        };
        const signing = this.bodySignature(request, body);
        let signed: NoteComment["signed"] = null;
        if (signing !== null) {
          const fields: SignedEnvelopeFields = {
            type: "commented",
            accountId: this.options.ownerId,
            workspaceId,
            noteId: body.noteId,
            commentId: body.id,
            revision: 1,
            ciphertextSha256: ciphertextSha256(fromBase64Url(body.ciphertext)),
            createdAt: signing.signedAt,
          };
          this.verify(fields, signing.signature);
          signed = { envelope: fields, signature: signing.signature } as NoteComment["signed"];
        }
        const seq = this.bump();
        const comment: NoteComment = {
          id: body.id,
          workspaceId,
          noteId: body.noteId,
          authorId: this.actorOf(request),
          authorTokenId: request.caller === "agent" ? this.options.tokenId : null,
          createdAt: now,
          updatedAt: now,
          revision: 1,
          seq,
          ciphertext: body.ciphertext,
          signed,
        };
        this.comments.push(comment);
        this.recordChange(`comment:${body.id}`, {
          kind: "comment",
          seq,
          at: now,
          commentId: body.id,
          noteId: body.noteId,
        });
        return response(201, { comment });
      }
      case "updateComment": {
        const commentId = request.params["commentId"];
        const index = this.comments.findIndex((comment) => comment.id === commentId);
        const current = this.comments[index];
        if (current === undefined) throw new HttpError("not_found");
        const body = this.json(request) as {
          baseRevision: number;
          ciphertext: string;
          signedAt?: string;
          signature?: string;
        };
        if (body.baseRevision !== current.revision) {
          throw new HttpError("conflict", { currentVersion: current.revision });
        }
        const signing = this.bodySignature(request, body);
        let signed: NoteComment["signed"] = null;
        if (signing !== null) {
          const fields: SignedEnvelopeFields = {
            type: "commented",
            accountId: this.options.ownerId,
            workspaceId,
            noteId: current.noteId,
            commentId: current.id,
            revision: current.revision + 1,
            ciphertextSha256: ciphertextSha256(fromBase64Url(body.ciphertext)),
            createdAt: signing.signedAt,
          };
          this.verify(fields, signing.signature);
          signed = { envelope: fields, signature: signing.signature } as NoteComment["signed"];
        }
        const seq = this.bump();
        const comment: NoteComment = {
          ...current,
          revision: current.revision + 1,
          updatedAt: now,
          seq,
          ciphertext: body.ciphertext,
          signed,
        };
        this.comments[index] = comment;
        return response(200, { comment });
      }
      case "recordCheck": {
        const body = this.json(request) as {
          id: CheckId;
          noteId: NoteId;
          noteVersion: number;
          ciphertext: string;
        };
        const check: CheckRecord = {
          id: body.id,
          workspaceId,
          noteId: body.noteId,
          noteVersion: body.noteVersion,
          authorId: this.options.tokenId,
          authorTokenId: this.options.tokenId,
          createdAt: now,
          status: "unapplied",
          appliedVersion: null,
          resolvedAt: null,
          seq: this.bump(),
          ciphertext: body.ciphertext,
        };
        this.checks.push(check);
        return response(201, { check });
      }
      case "addEvent": {
        const body = this.json(request) as {
          id: EventId;
          noteId: NoteId;
          noteVersion: number | null;
          ciphertext: string;
          signedAt?: string;
          signature?: string;
        };
        const signing = this.bodySignature(request, body);
        let signed: NoteEvent["signed"] = null;
        if (signing !== null) {
          const fields: SignedEnvelopeFields = {
            type: "recorded",
            accountId: this.options.ownerId,
            workspaceId,
            noteId: body.noteId,
            eventId: body.id,
            ciphertextSha256: ciphertextSha256(fromBase64Url(body.ciphertext)),
            createdAt: signing.signedAt,
          };
          this.verify(fields, signing.signature);
          signed = { envelope: fields, signature: signing.signature } as NoteEvent["signed"];
        }
        const event: NoteEvent = {
          id: body.id,
          workspaceId,
          noteId: body.noteId,
          noteVersion: body.noteVersion,
          authorId: this.actorOf(request),
          authorTokenId: request.caller === "agent" ? this.options.tokenId : null,
          createdAt: now,
          seq: this.bump(),
          ciphertext: body.ciphertext,
          signed,
        };
        this.events.push(event);
        return response(201, { event });
      }
      default:
        return this.routeConnect(request);
    }
  }

  /** The agent token as the server describes it. */
  agentTokenInfo(): AgentToken {
    return {
      id: this.options.tokenId,
      workspaceId: this.options.workspaceId,
      encName: this.options.encName,
      access: this.agentAccess,
      folderIds: [...this.agentFolderIds],
      publicKey: toBase64Url(this.options.agentPublicKey ?? new Uint8Array(32)),
      signPublicKey: this.agentSignPublicKey === null ? null : toBase64Url(this.agentSignPublicKey),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: this.tokenRevoked ? new Date().toISOString() : null,
    };
  }

  /** Connect requests, the agent's own token and revocation. */
  private routeConnect(request: Request): FetchResponse {
    switch (request.name) {
      case "startConnect": {
        const requestId = this.id("cr");
        const pollSecret = `ktp_${"p".repeat(40)}${String(this.counter)}`;
        this.connectRequests.set(requestId, { pollSecret, status: "pending" });
        return response(201, {
          requestId,
          pollSecret,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          pollIntervalSeconds: 1,
        });
      }
      case "pollConnect": {
        const entry = this.connectRequests.get(request.params["requestId"] ?? "");
        const body = this.json(request) as { pollSecret: string };
        if (entry?.pollSecret !== body.pollSecret) {
          throw new HttpError("not_found");
        }
        if (entry.relay !== undefined) {
          const relay = entry.relay;
          delete entry.relay;
          return response(200, { status: "relayed", encRelayPayload: relay });
        }
        if (entry.status === "pending" || entry.status === "approved") {
          return response(200, { status: entry.status, pollIntervalSeconds: 1 });
        }
        return response(200, { status: entry.status });
      }
      case "getCurrentToken":
        return response(200, { token: this.agentTokenInfo() });
      case "approveConnect": {
        // the agent-key part of the sync API's approval (the token and keys are the World's)
        const body = this.json(request) as {
          tokenId: TokenId;
          signPublicKey?: string;
          agentKeySignedAt?: string;
          agentKeySignature?: string;
        };
        if (body.tokenId !== this.options.tokenId) throw new HttpError("invalid_request");
        if (
          body.signPublicKey !== undefined &&
          body.agentKeySignedAt !== undefined &&
          body.agentKeySignature !== undefined
        ) {
          this.vouchAgentKey({
            signPublicKey: body.signPublicKey,
            agentKeySignedAt: body.agentKeySignedAt,
            agentKeySignature: body.agentKeySignature,
          });
        } else {
          this.agentSignPublicKey = null;
        }
        return response(200, { token: this.agentTokenInfo() });
      }
      case "listPending": {
        const status = request.query.get("status");
        const noteId = request.query.get("noteId");
        const submittedBy = request.query.get("submittedBy");
        const since = Number(request.query.get("since") ?? "0");
        const pending = [...this.pending.values()]
          .map((entry) => entry.change)
          .filter(
            (change) =>
              change.seq > since &&
              (status === null || change.status === status) &&
              (noteId === null || change.noteId === noteId) &&
              (submittedBy === null || change.submittedBy === submittedBy) &&
              (request.caller !== "agent" || this.folderInScope(change.folderId)),
          )
          .sort((a, b) => a.seq - b.seq);
        return response(200, this.page("pending", pending, request));
      }
      case "revokeToken": {
        if (request.params["tokenId"] !== this.options.tokenId) throw new HttpError("not_found");
        const signature = request.headers.get("knowtarium-signature");
        const signedAt = request.headers.get("knowtarium-signed-at");
        if (request.caller === "session" && signature !== undefined && signedAt !== undefined) {
          // the owner's revocation, rebuilt from the token's stored public key
          const envelope: SignedEnvelopeFields = {
            type: "token_revoked",
            accountId: this.options.ownerId,
            workspaceId: this.options.workspaceId,
            recipient: toBase64Url(this.options.agentPublicKey ?? new Uint8Array(32)),
            tokenId: this.options.tokenId,
            createdAt: signedAt,
          };
          this.verify(envelope, signature);
          this.revocations.push({
            workspaceId: this.options.workspaceId,
            tokenId: this.options.tokenId,
            signed: { envelope, signature } as TokenRevocation["signed"],
          });
        }
        this.tokenRevoked = true;
        this.tokenRevokedAt ??= new Date().toISOString();
        return response(200, {
          ok: true,
          mustRotateKey: { workspaceId: this.options.workspaceId },
        });
      }
      default:
        throw new HttpError("not_found");
    }
  }

  /** Whether the agent's scope holds a folder (its own, or one of its ancestors). */
  folderInScope(folderId: FolderId): boolean {
    if (this.agentFolderIds.length === 0) return true;
    const seen = new Set<FolderId>();
    for (let current: FolderId | null = folderId; current !== null && !seen.has(current);) {
      if (this.agentFolderIds.includes(current)) return true;
      seen.add(current);
      current = this.folders.get(current)?.parentId ?? null;
    }
    return false;
  }

  /** Whether the agent's scope holds a note (a note not stored yet counts as outside). */
  private noteInScope(noteId: NoteId): boolean {
    if (this.agentFolderIds.length === 0) return true;
    const row = this.notes.get(noteId);
    return row !== undefined && this.folderInScope(row.folderId);
  }

  /** Refuses an agent request that reaches outside its folders, like the sync API. */
  private checkScope(request: Request): void {
    if (request.caller !== "agent" || this.agentFolderIds.length === 0) return;
    const noteId = request.params["noteId"] as NoteId | undefined;
    if (noteId !== undefined && this.notes.has(noteId) && !this.noteInScope(noteId)) {
      throw new HttpError("scope_denied");
    }
    const pending = this.pending.get(request.params["pendingId"] as PendingId);
    if (pending !== undefined && !this.folderInScope(pending.change.folderId)) {
      throw new HttpError("scope_denied");
    }
    const folderId = request.headers.get("knowtarium-folder-id") as FolderId | undefined;
    if (folderId !== undefined && !this.folderInScope(folderId)) {
      throw new HttpError("scope_denied");
    }
    // a JSON body naming a note (comments, checks, events)
    if (request.body?.[0] === 0x7b) {
      let target: unknown;
      try {
        target = this.json(request)["noteId"];
      } catch {
        target = undefined;
      }
      if (typeof target === "string" && !this.noteInScope(target as NoteId)) {
        throw new HttpError("scope_denied");
      }
    }
  }

  /** A changes feed entry the agent may see. */
  private changeInScope(change: ChangeEntry): boolean {
    switch (change.kind) {
      case "workspace":
        return true;
      case "folder":
        return this.folderInScope(change.folderId);
      case "note":
      case "attachment":
        return this.folderInScope(change.folderId);
      default:
        return this.noteInScope(change.noteId);
    }
  }

  /**
   * Records after the query's `since`, for its note if it names one, ordered by `seq`; for an
   * agent, only those of notes in its folders.
   */
  private records<T extends { readonly seq: number; readonly noteId: NoteId }>(
    rows: readonly T[],
    request: Request,
  ): T[] {
    const since = Number(request.query.get("since") ?? "0");
    const noteId = request.query.get("noteId");
    return rows
      .filter((row) => row.seq > since && (noteId === null || row.noteId === noteId))
      .filter((row) => request.caller !== "agent" || this.noteInScope(row.noteId))
      .sort((a, b) => a.seq - b.seq);
  }

  /** One page of a list paged by `seq`, at most the query's `limit`. */
  private page(key: string, rows: readonly unknown[], request: Request): Record<string, unknown> {
    const limit = Number(request.query.get("limit") ?? "1000");
    return {
      [key]: rows.slice(0, limit),
      workspaceVersion: this.seq,
      hasMore: rows.length > limit,
    };
  }

  /**
   * The current policy or an old revision; an agent gets its view (`agentPolicyViewFor`, also at
   * revision 0, so a scoped token gets its ancestors).
   */
  private async getAgentPolicy(request: Request): Promise<FetchResponse> {
    const asked = request.query.get("revision");
    let policy = this.agentPolicy;
    if (asked !== null) {
      const revision = Number(asked);
      const found =
        revision === 0
          ? missingAgentPolicy()
          : this.agentPolicies.find((p) => p.revision === revision);
      if (found === undefined) throw new HttpError("not_found");
      policy = found;
    }
    if (request.caller === "agent") {
      policy = await agentPolicyViewFor(policy, this.agentFolderIds, this.folderLookup);
    }
    return response(200, { policy: this.tamper.agentPolicy?.(policy) ?? policy });
  }

  /** The owner replaces the policy: the base revision, then `agent_policy` rebuilt and verified. */
  private async setAgentPolicy(request: Request): Promise<FetchResponse> {
    const body = this.json(request) as {
      default: AgentWriteMode;
      folders: AgentPolicyFolder[];
      baseRevision: number;
      signedAt: string;
      signature: string;
    };
    const current = this.agentPolicy;
    if (body.baseRevision !== current.revision) {
      throw new HttpError("conflict", { currentVersion: current.revision });
    }
    const outside = body.folders.findIndex((folder) => !this.folders.has(folder.folderId));
    if (outside !== -1) {
      throw invalid(["body", "folders", outside, "folderId"], "Not a folder of this workspace");
    }
    const envelope: SignedEnvelopeFields = {
      type: "agent_policy",
      accountId: this.options.ownerId,
      workspaceId: this.options.workspaceId,
      revision: body.baseRevision + 1,
      policySha256: await agentPolicySha256({ default: body.default, folders: body.folders }),
      createdAt: body.signedAt,
    };
    this.verify(envelope, body.signature);
    const at = new Date().toISOString();
    const policy: AgentPolicy = {
      default: body.default,
      folders: body.folders,
      revision: body.baseRevision + 1,
      updatedAt: at,
      updatedBy: this.options.ownerId,
      signed: { envelope, signature: body.signature } as NonNullable<AgentPolicy["signed"]>,
    };
    this.agentPolicies.push(policy);
    const seq = this.bump();
    this.recordChange("workspace", {
      kind: "workspace",
      seq,
      at,
      encName: this.options.encName,
      keyGeneration: this.keyGeneration,
      agentPolicyRevision: policy.revision,
    });
    return response(200, { policy, workspaceVersion: seq });
  }

  /**
   * An agent's direct write, refused in the sync API's order: scope (checked for every request),
   * then a missing key, a stale revision, the signature, the folder's mode, the base version.
   */
  private writeNoteAsAgent(request: Request): FetchResponse {
    const { headers } = request;
    const noteId = request.params["noteId"] as NoteId;
    const folderId = headers.get("knowtarium-folder-id") as FolderId;
    const base = Number(/^"(\d+)"$/.exec(headers.get("if-match") ?? "")?.[1] ?? "-1");
    if (this.agentAccess === "read") throw new HttpError("scope_denied");
    if (!this.folders.has(folderId)) throw new HttpError("not_found");
    const signKey = this.agentSignPublicKey;
    if (signKey === null) throw new HttpError("agent_key_required");
    if (this.agentWrites >= this.agentWriteDailyCap) {
      throw new HttpError("rate_limited", { retryAfterSeconds: 3600 }, { "Retry-After": "3600" });
    }
    const policy = this.agentPolicy;
    const header = headers.get("knowtarium-agent-policy-revision");
    if (header === undefined) {
      throw invalid(["headers", "knowtarium-agent-policy-revision"], "Required");
    }
    const revision = Number(header);
    if (revision !== policy.revision) throw new HttpError("stale_agent_policy");
    const body = request.body ?? new Uint8Array();
    const envelope: SignedEnvelopeFields = {
      type: "agent_edited",
      accountId: this.options.ownerId,
      workspaceId: this.options.workspaceId,
      tokenId: this.options.tokenId,
      noteId,
      version: base + 1,
      folderId,
      ciphertextSha256: ciphertextSha256(body),
      revision,
      policySha256: policy.signed?.envelope.policySha256 ?? MISSING_AGENT_POLICY_SHA256,
      createdAt: headers.get("knowtarium-signed-at") ?? "",
    };
    const signature = headers.get("knowtarium-signature");
    this.verify(envelope, signature, signKey);
    // a signature is good for one write (the sync API remembers them)
    if (this.usedAgentSignatures.has(signature ?? "")) throw new HttpError("invalid_signature");
    const from = this.notes.get(noteId)?.folderId;
    const folders = from === undefined || from === folderId ? [folderId] : [from, folderId];
    if (
      folders.some(
        (folder) =>
          effectiveMode(policy, agentPolicyAncestry(folder, this.folderLookup)) !== "direct",
      )
    ) {
      throw new HttpError("approval_required");
    }
    const current = this.currentVersion(noteId);
    if (base !== current) throw new HttpError("conflict", { currentVersion: current });
    this.usedAgentSignatures.add(signature ?? "");
    this.agentWrites++;
    const stored = this.storeVersion(
      noteId,
      folderId,
      body,
      { envelope, signature: signature ?? "" },
      null,
      true,
    );
    return response(200, stored, { ETag: `"${String(stored.note.currentVersion)}"` });
  }

  private route(request: Request): FetchResponse | Promise<FetchResponse> {
    const { params, headers } = request;
    const workspaceId = this.options.workspaceId;
    if (params["workspaceId"] !== undefined && params["workspaceId"] !== workspaceId) {
      throw new HttpError("not_found");
    }
    const noteId = params["noteId"] as NoteId;
    const pendingId = params["pendingId"] as PendingId;
    const signedAt = headers.get("knowtarium-signed-at") ?? "";
    const signature = headers.get("knowtarium-signature");
    switch (request.name) {
      case "listKeys":
        return response(200, {
          workspaceKeys: request.caller === "agent" ? this.agentKeys : this.sessionKeys,
          // the owner's view: every recipient's copy of the current generation
          ...(request.caller === "session"
            ? {
                recipients: [
                  ...this.sessionKeys.map((record) => ({ ...record, revokedAt: null })),
                  ...this.agentKeys.map((record) => ({
                    ...record,
                    revokedAt: this.tokenRevokedAt,
                  })),
                ].filter((record) => record.keyGeneration === this.keyGeneration),
                revocations: this.revocations,
              }
            : {}),
          // every vouched agent key, for sessions and agents, the revoked token's marked
          agentKeys: [
            ...(request.caller === "session" ? this.otherWorkspaceAgentKeys : []),
            ...this.agentKeyRecords.map((record) => ({
              ...record,
              revokedAt:
                record.revokedAt ??
                (record.signed.envelope.tokenId === this.options.tokenId
                  ? this.tokenRevokedAt
                  : null),
            })),
          ],
        });
      case "getAgentPolicy":
        return this.getAgentPolicy(request);
      case "setAgentPolicy":
        return this.setAgentPolicy(request);
      case "writeNoteAsAgent":
        return this.writeNoteAsAgent(request);
      case "rotateWorkspaceKey": {
        const body = this.json(request) as {
          keyGeneration: number;
          keyCommitment: string;
          generationSignedAt: string;
          generationSignature: string;
          wrappedKeys: {
            recipient: KeyRecipient;
            encWorkspaceKey: string;
            signedAt: string;
            signature: string;
          }[];
        };
        if (body.keyGeneration !== this.keyGeneration + 1) throw new HttpError("conflict");
        // each recipient's public key as the server stored it, never from the request
        const publicKeyOf = (recipient: KeyRecipient): Uint8Array => {
          if (recipient.kind === "account") return this.options.ownerBoxPublicKey;
          if (recipient.tokenId !== this.options.tokenId || this.tokenRevoked) {
            throw new HttpError("invalid_request");
          }
          return this.options.agentPublicKey ?? new Uint8Array(32);
        };
        const generationEnvelope: SignedEnvelopeFields = {
          type: "key_generation",
          accountId: this.options.ownerId,
          workspaceId: this.options.workspaceId,
          generation: body.keyGeneration,
          recipientsHash: recipientsHash(
            body.wrappedKeys.map((copy) => publicKeyOf(copy.recipient)),
          ),
          keyCommitment: body.keyCommitment,
          createdAt: body.generationSignedAt,
        };
        this.verify(generationEnvelope, body.generationSignature);
        const signedGeneration = {
          envelope: generationEnvelope,
          signature: body.generationSignature,
        } as WrappedWorkspaceKey["signedGeneration"];
        const at = new Date().toISOString();
        for (const copy of body.wrappedKeys) {
          const envelope: SignedEnvelopeFields = {
            type: "wrapped_key",
            accountId: this.options.ownerId,
            workspaceId: this.options.workspaceId,
            recipient: toBase64Url(publicKeyOf(copy.recipient)),
            holder: copy.recipient.kind === "account" ? "account" : copy.recipient.tokenId,
            generation: body.keyGeneration,
            ciphertextSha256: ciphertextSha256(fromBase64Url(copy.encWorkspaceKey)),
            createdAt: copy.signedAt,
          };
          this.verify(envelope, copy.signature);
          const record: WrappedWorkspaceKey = {
            workspaceId: this.options.workspaceId,
            recipient: copy.recipient,
            keyGeneration: body.keyGeneration,
            encWorkspaceKey: copy.encWorkspaceKey,
            createdAt: at,
            signed: { envelope, signature: copy.signature } as WrappedWorkspaceKey["signed"],
            signedGeneration,
          };
          if (copy.recipient.kind === "account") this.sessionKeys = [...this.sessionKeys, record];
          else this.agentKeys = [...this.agentKeys, record];
        }
        this.keyGeneration = body.keyGeneration;
        this.rotations++;
        const seq = this.bump();
        this.recordChange("workspace", {
          kind: "workspace",
          seq,
          at,
          encName: this.options.encName,
          keyGeneration: this.keyGeneration,
          ...(this.agentPolicy.revision === 0
            ? {}
            : { agentPolicyRevision: this.agentPolicy.revision }),
        });
        return response(200, {
          workspace: {
            id: this.options.workspaceId,
            encName: this.options.encName,
            ownerId: this.options.ownerId,
            ownerSignPublicKey: toBase64Url(this.options.ownerSigningPublicKey),
            keyGeneration: this.keyGeneration,
            currentVersion: 0,
            createdAt: at,
            updatedAt: at,
          },
        });
      }
      case "replaceRecoveryKey": {
        this.recoveryKeyReplacements.push(this.json(request));
        return response(200, { ok: true });
      }
      case "createLiveTicket":
        this.tickets++;
        return response(201, {
          ticket: `ktl_${String(this.tickets).padStart(40, "t")}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      case "listChanges": {
        const since = Number(request.query.get("since") ?? "0");
        const limit = Number(request.query.get("limit") ?? "1000");
        let all = [...this.changes.values()].filter(
          (change) =>
            change.seq > since && (request.caller !== "agent" || this.changeInScope(change)),
        );
        all.sort((a, b) => a.seq - b.seq);
        all = this.tamper.feed?.(all) ?? all;
        const page: ChangesPage = {
          workspaceVersion: this.seq,
          changes: all.slice(0, limit),
          hasMore: all.length > limit,
        };
        return response(200, this.tamper.changesPage?.(page) ?? page);
      }
      case "listEvents": {
        const all = this.records(this.events, request);
        const events = this.tamper.events?.(all) ?? all;
        return response(200, this.page("events", events, request));
      }
      case "listComments":
        return response(200, this.page("comments", this.records(this.comments, request), request));
      case "listChecks": {
        const status = request.query.get("status");
        const checks = this.records(this.checks, request).filter(
          (check) => status === null || check.status === status,
        );
        return response(200, this.page("checks", checks, request));
      }
      case "getNote":
        return response(200, { note: this.noteMeta(noteId) });
      case "getVersions": {
        // like the sync API: exact versions, scope applied per note, a byte cap per answer
        const body = this.json(request) as { versions: { noteId: NoteId; version: number }[] };
        this.versionBatches++;
        const versions: { noteId: NoteId; version: number; ciphertext: string }[] = [];
        const omitted: { noteId: NoteId; version: number }[] = [];
        let bytes = 0;
        for (const wanted of body.versions) {
          const row = this.notes
            .get(wanted.noteId)
            ?.versions.find((entry) => entry.version === wanted.version);
          const inScope = request.caller !== "agent" || this.noteInScope(wanted.noteId);
          if (row?.blob == null || !inScope || bytes + row.blob.length > this.versionBatchBytes) {
            omitted.push(wanted);
            continue;
          }
          const blob =
            this.tamper.versionBlob?.(wanted.noteId, wanted.version, row.blob) ?? row.blob;
          bytes += blob.length;
          versions.push({ ...wanted, ciphertext: toBase64Url(blob) });
        }
        return response(200, { versions, omitted });
      }
      case "getVersion": {
        const version = Number(params["version"]);
        const row = this.notes.get(noteId)?.versions.find((entry) => entry.version === version);
        // like the sync API: a version removed after the history period is gone for good
        if (row?.prunedAt != null) throw new HttpError("expired");
        if (row?.blob == null) throw new HttpError("not_found");
        const blob = this.tamper.versionBlob?.(noteId, version, row.blob) ?? row.blob;
        return response(200, blob, { ETag: `"${String(version)}"` });
      }
      case "writeNote": {
        const base = Number(/^"(\d+)"$/.exec(headers.get("if-match") ?? "")?.[1] ?? "-1");
        const folderId = headers.get("knowtarium-folder-id") as FolderId;
        const current = this.currentVersion(noteId);
        if (base !== current) throw new HttpError("conflict", { currentVersion: current });
        const body = request.body ?? new Uint8Array();
        // applying an agent's passing check: signed as check_applied, the record marked applied
        const checkId = headers.get("knowtarium-check-id") ?? null;
        const applied =
          checkId === null ? undefined : this.checks.find((entry) => entry.id === checkId);
        if (checkId !== null && (applied?.noteId !== noteId || applied.status !== "unapplied")) {
          // no open check of this note by that ID
          throw new HttpError("not_found");
        }
        const envelope: SignedEnvelopeFields = {
          type: checkId === null ? "edited" : "check_applied",
          accountId: this.options.ownerId,
          workspaceId,
          noteId,
          folderId,
          version: base + 1,
          ciphertextSha256: ciphertextSha256(body),
          ...(checkId === null ? {} : { checkId }),
          createdAt: signedAt,
        };
        this.verify(envelope, signature);
        const stored = this.storeVersion(
          noteId,
          folderId,
          body,
          {
            envelope,
            signature: signature ?? "",
          },
          null,
        );
        if (applied !== undefined) {
          this.checks[this.checks.indexOf(applied)] = {
            ...applied,
            status: "applied",
            appliedVersion: stored.note.currentVersion,
            resolvedAt: new Date().toISOString(),
            seq: this.bump(),
          };
        }
        return response(200, stored, { ETag: `"${String(stored.note.currentVersion)}"` });
      }
      case "deleteNote": {
        const base = Number(/^"(\d+)"$/.exec(headers.get("if-match") ?? "")?.[1] ?? "-1");
        const current = this.currentVersion(noteId);
        if (base !== current) throw new HttpError("conflict", { currentVersion: current });
        const envelope: SignedEnvelopeFields = {
          type: "deleted",
          accountId: this.options.ownerId,
          workspaceId,
          noteId,
          version: base + 1,
          createdAt: signedAt,
        };
        this.verify(envelope, signature);
        const folderId = this.noteMeta(noteId).folderId;
        return response(
          200,
          this.storeVersion(noteId, folderId, null, { envelope, signature: signature ?? "" }, null),
        );
      }
      case "submitPending": {
        if (this.agentAccess === "read") throw new HttpError("scope_denied");
        const base = Number(/^"(\d+)"$/.exec(headers.get("if-match") ?? "")?.[1] ?? "-1");
        const current = this.currentVersion(noteId);
        if (base !== current) throw new HttpError("conflict", { currentVersion: current });
        const seq = this.bump();
        const createdAt = new Date().toISOString();
        const blob = request.body ?? new Uint8Array();
        const change: PendingChange = {
          id: this.id("pc"),
          workspaceId,
          noteId,
          folderId: headers.get("knowtarium-folder-id") as FolderId,
          baseVersion: base,
          clientNonce: headers.get("knowtarium-pending-nonce") ?? "",
          sizeBytes: blob.length,
          submittedBy: this.options.tokenId,
          authorTokenId: this.options.tokenId,
          createdAt,
          status: "open",
          decidedAt: null,
          resultingVersion: null,
          rejectionCommentId: null,
          seq,
        };
        this.pending.set(change.id, { change, blob });
        this.recordChange(`pending:${change.id}`, {
          kind: "pending",
          seq,
          at: createdAt,
          pendingId: change.id,
          noteId,
          status: "open",
        });
        return response(201, { pending: change });
      }
      case "getPending":
        return response(200, { pending: this.openPending(pendingId, false).change });
      case "getPendingBlob":
        return response(200, this.openPending(pendingId, false).blob);
      case "approvePending": {
        const entry = this.openPending(pendingId, true);
        const current = this.currentVersion(entry.change.noteId);
        if (entry.change.baseVersion !== current) {
          throw new HttpError("conflict", { currentVersion: current });
        }
        const body = request.body ?? new Uint8Array();
        const envelope: SignedEnvelopeFields = {
          type: "approved",
          accountId: this.options.ownerId,
          workspaceId,
          noteId: entry.change.noteId,
          pendingId,
          version: current + 1,
          folderId: entry.change.folderId,
          ciphertextSha256: ciphertextSha256(body),
          createdAt: signedAt,
        };
        this.verify(envelope, signature);
        const stored = this.storeVersion(
          entry.change.noteId,
          entry.change.folderId,
          body,
          { envelope, signature: signature ?? "" },
          pendingId,
        );
        const decided: PendingChange = {
          ...entry.change,
          status: "approved",
          decidedAt: stored.event.createdAt,
          resultingVersion: stored.note.currentVersion,
          seq: stored.workspaceVersion,
        };
        this.decide(entry, decided, stored.workspaceVersion);
        return response(
          200,
          { ...stored, pending: decided },
          {
            ETag: `"${String(stored.note.currentVersion)}"`,
          },
        );
      }
      case "rejectPending": {
        const entry = this.openPending(pendingId, true);
        const body = this.json(request) as {
          commentId: `cmt_${string}`;
          ciphertext: string;
          signedAt: string;
          signature: string;
        };
        const envelope: SignedEnvelopeFields = {
          type: "rejected",
          accountId: this.options.ownerId,
          workspaceId,
          noteId: entry.change.noteId,
          pendingId,
          commentId: body.commentId,
          ciphertextSha256: ciphertextSha256(fromBase64Url(body.ciphertext)),
          createdAt: body.signedAt,
        };
        this.verify(envelope, body.signature);
        const seq = this.bump();
        const createdAt = new Date().toISOString();
        const signed = { envelope, signature: body.signature } as NoteEvent["signed"];
        const comment: NoteComment = {
          id: body.commentId,
          workspaceId,
          noteId: entry.change.noteId,
          authorId: this.options.ownerId,
          authorTokenId: null,
          createdAt,
          updatedAt: createdAt,
          revision: 1,
          seq,
          ciphertext: body.ciphertext,
          signed,
        };
        this.comments.push(comment);
        const event: NoteEvent = {
          id: this.id("evt"),
          workspaceId,
          noteId: entry.change.noteId,
          noteVersion: null,
          authorId: this.options.ownerId,
          authorTokenId: null,
          createdAt,
          seq,
          ciphertext: null,
          signed,
        };
        this.events.push(event);
        const decided: PendingChange = {
          ...entry.change,
          status: "rejected",
          decidedAt: createdAt,
          rejectionCommentId: comment.id,
          seq,
        };
        this.decide(entry, decided, seq);
        return response(200, { pending: decided, comment, event });
      }
      case "createFolder": {
        const body = this.json(request) as {
          id: FolderId;
          parentId: FolderId | null;
          encName: string;
          signedAt: string;
          signature: string;
        };
        const envelope: SignedEnvelopeFields = {
          type: "folder_created",
          accountId: this.options.ownerId,
          workspaceId,
          folderId: body.id,
          ...(body.parentId === null ? {} : { parentId: body.parentId }),
          ciphertextSha256: ciphertextSha256(fromBase64Url(body.encName)),
          createdAt: body.signedAt,
        };
        this.verify(envelope, body.signature);
        const seq = this.bump();
        const at = new Date().toISOString();
        this.folders.set(body.id, { parentId: body.parentId, encName: body.encName });
        this.recordChange(`folder:${body.id}`, {
          kind: "folder",
          seq,
          at,
          folderId: body.id,
          parentId: body.parentId,
          encName: body.encName,
          deleted: false,
          createdAt: at,
        });
        const folder = {
          id: body.id,
          workspaceId,
          parentId: body.parentId,
          encName: body.encName,
          createdAt: at,
          updatedAt: at,
        };
        return response(201, { folder, workspaceVersion: seq });
      }
      case "createWorkspace": {
        const body = this.json(request) as {
          id: WorkspaceId;
          encName: string;
          encWorkspaceKey: string;
          signedAt: string;
          signature: string;
          keyCommitment: string;
          generationSignedAt: string;
          generationSignature: string;
        };
        this.verify(
          {
            type: "key_generation",
            accountId: this.options.ownerId,
            workspaceId: body.id,
            generation: 1,
            recipientsHash: recipientsHash([this.options.ownerBoxPublicKey]),
            keyCommitment: body.keyCommitment,
            createdAt: body.generationSignedAt,
          },
          body.generationSignature,
        );
        this.verify(
          {
            type: "wrapped_key",
            accountId: this.options.ownerId,
            workspaceId: body.id,
            recipient: toBase64Url(this.options.ownerBoxPublicKey),
            holder: "account",
            generation: 1,
            ciphertextSha256: ciphertextSha256(fromBase64Url(body.encWorkspaceKey)),
            createdAt: body.signedAt,
          },
          body.signature,
        );
        const at = new Date().toISOString();
        return response(201, {
          workspace: {
            id: body.id,
            encName: body.encName,
            ownerId: this.options.ownerId,
            ownerSignPublicKey: toBase64Url(this.options.ownerSigningPublicKey),
            keyGeneration: 1,
            currentVersion: 0,
            createdAt: at,
            updatedAt: at,
          },
        });
      }
      default:
        return (
          this.routeAttachments(request) ??
          this.routeHistorySettings(request) ??
          this.routeHistory(request)
        );
    }
  }

  /** The attachment routes, or undefined for any other. */
  private routeAttachments(request: Request): FetchResponse | undefined {
    const workspaceId = this.options.workspaceId;
    const attachmentId = request.params["attachmentId"] as AttachmentId;
    const stored = () => {
      const entry = this.attachments.get(attachmentId);
      if (entry === undefined) throw new HttpError("not_found");
      if (request.caller === "agent" && !this.folderInScope(entry.attachment.folderId)) {
        throw new HttpError("scope_denied");
      }
      return entry;
    };
    const announce = (attachment: Attachment, deleted: boolean) => {
      const seq = this.bump();
      this.recordChange(`attachment:${attachment.id}`, {
        kind: "attachment",
        seq,
        at: new Date().toISOString(),
        attachmentId: attachment.id,
        folderId: attachment.folderId,
        encMeta: deleted ? null : attachment.encMeta,
        createdAt: attachment.createdAt,
        deleted,
      });
      return seq;
    };
    switch (request.name) {
      case "createAttachment": {
        const body = this.json(request) as {
          id: AttachmentId;
          folderId: FolderId;
          encMeta: string;
          sizeBytes: number;
          chunkCount: number;
        };
        const existing = this.attachments.get(body.id);
        if (existing !== undefined) {
          // a retry of the same create answers what is stored; anything else is a conflict
          const same =
            existing.attachment.encMeta === body.encMeta &&
            existing.attachment.folderId === body.folderId &&
            existing.attachment.sizeBytes === body.sizeBytes &&
            existing.attachment.chunkCount === body.chunkCount;
          if (!same) throw new HttpError("conflict", { currentVersion: 0 });
          return response(201, { attachment: existing.attachment });
        }
        if (request.caller === "agent" && !this.folderInScope(body.folderId)) {
          throw new HttpError("scope_denied");
        }
        // the sync API's rule: none over the chunk limit, none smaller than an envelope plus a byte
        if (!attachmentChunkCountFits(body.sizeBytes, body.chunkCount)) {
          throw invalid(["body", "chunkCount"], "The chunk count doesn't fit the size");
        }
        const used = [...this.attachments.values()].reduce(
          (sum, entry) => sum + entry.attachment.sizeBytes,
          0,
        );
        if (used + body.sizeBytes > this.quotaBytes) {
          throw new HttpError("quota_exceeded", {
            plan: { id: "free", storageQuotaBytes: this.quotaBytes, maxWorkspaces: 1 },
            usage: {
              usedBytes: used,
              quotaBytes: this.quotaBytes,
              workspaceCount: 1,
              maxWorkspaces: 1,
            },
          });
        }
        const attachment: Attachment = {
          id: body.id,
          workspaceId,
          folderId: body.folderId,
          encMeta: body.encMeta,
          sizeBytes: body.sizeBytes,
          chunkCount: body.chunkCount,
          chunksReceived: 0,
          status: "uploading",
          authorId: this.actorOf(request),
          createdAt: new Date().toISOString(),
        };
        this.attachments.set(body.id, { attachment, chunks: [] });
        return response(201, { attachment });
      }
      case "uploadAttachmentChunk": {
        const entry = stored();
        const index = Number(request.params["chunkIndex"]);
        const bytes = request.body ?? new Uint8Array();
        // as the sync API checks a chunk: its size, an envelope, its index, the running total
        if (bytes.length > LIMITS.attachmentChunkBytes) throw new HttpError("payload_too_large");
        if (bytes.length < ENVELOPE_OVERHEAD_BYTES) {
          throw invalid(["body"], "Expected an encrypted envelope");
        }
        // chunks come in order here (the client sends them so); the server takes any order
        if (index > entry.chunks.length || index >= entry.attachment.chunkCount) {
          throw invalid(["params", "chunkIndex"], "chunkIndex is past the announced chunk count");
        }
        const received = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const replaced = entry.chunks[index]?.length ?? 0;
        if (received - replaced + bytes.length > entry.attachment.sizeBytes) {
          throw invalid(["body"], "The chunks add up to more than the announced size");
        }
        entry.chunks[index] = bytes;
        entry.attachment = { ...entry.attachment, chunksReceived: entry.chunks.length };
        return response(200, { attachment: entry.attachment });
      }
      case "completeAttachment": {
        const entry = stored();
        if (entry.attachment.status !== "complete") {
          const received = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          if (
            entry.chunks.length !== entry.attachment.chunkCount ||
            received !== entry.attachment.sizeBytes
          ) {
            throw invalid(["params", "attachmentId"], "Not every chunk is stored yet");
          }
          entry.attachment = { ...entry.attachment, status: "complete" };
          announce(entry.attachment, false);
        }
        return response(200, { attachment: entry.attachment });
      }
      case "getAttachment":
        return response(200, { attachment: stored().attachment });
      case "getAttachmentChunk": {
        const chunk = stored().chunks[Number(request.params["chunkIndex"])];
        if (chunk === undefined) throw new HttpError("not_found");
        return response(200, chunk);
      }
      case "deleteAttachment": {
        const entry = this.attachments.get(attachmentId);
        if (entry === undefined) return response(200, { workspaceVersion: this.seq });
        this.attachments.delete(attachmentId);
        return response(200, { workspaceVersion: announce(entry.attachment, true) });
      }
      default:
        return undefined;
    }
  }

  private openPending(
    pendingId: PendingId,
    mustBeOpen: boolean,
  ): { change: PendingChange; blob: Uint8Array } {
    const entry = this.pending.get(pendingId);
    if (entry === undefined) throw new HttpError("not_found");
    if (mustBeOpen && entry.change.status !== "open") throw new HttpError("pending_closed");
    return entry;
  }

  private decide(
    entry: { change: PendingChange; blob: Uint8Array },
    decided: PendingChange,
    seq: number,
  ): void {
    entry.change = decided;
    this.recordChange(`pending:${decided.id}`, {
      kind: "pending",
      seq,
      at: decided.decidedAt ?? new Date().toISOString(),
      pendingId: decided.id,
      noteId: decided.noteId,
      status: decided.status,
    });
  }
}
