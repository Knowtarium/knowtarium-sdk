import { AccountId, WorkspaceId } from "../../protocol/index.js";
import {
  type IdbDatabaseLike,
  type IdbFactoryLike,
  openStore,
  requestResult,
  transactionDone,
} from "../platform/indexeddb.js";
import { type CacheAdapter, MemoryCacheAdapter } from "./adapter.js";

const STORE = "entries";

/** A cache key: `/`-separated segments of ID characters, as `EncryptedCache` builds them. */
const SEGMENT = /^[A-Za-z0-9_.-]{1,128}$/;

function checkKey(key: string): string {
  const segments = key.split("/");
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) {
    throw new Error(`invalid cache key ${JSON.stringify(key)}`);
  }
  return key;
}

/** Why the cache runs in memory instead of IndexedDB. */
export interface CacheFallback {
  readonly reason: "quota" | "unavailable";
  readonly error: unknown;
}

/** Whether an IndexedDB failure means the storage is full. */
function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/**
 * The encrypted cache's `CacheAdapter` in the browser's IndexedDB: one database per account
 * (`knowtarium-cache-<account ID>`), keys namespaced per workspace (`ws/<workspace ID>/...`, as
 * `EncryptedCache` builds them), values as bytes. Like the file and memory adapters it only ever
 * holds what `EncryptedCache` gives it: ciphertext envelopes and small records of IDs, versions
 * and cursors, never plaintext; it refuses keys that aren't made of ID characters.
 *
 * When IndexedDB can't be opened (some private browsing modes) or a write hits the storage quota,
 * it carries on in memory for the rest of the session (the write that failed included), and says
 * so through `onFallback` and `fallback`: the app keeps working, only without an offline copy.
 */
export class IndexedDbCacheAdapter implements CacheAdapter {
  private memory: MemoryCacheAdapter | null = null;
  private reported: CacheFallback | null = null;

  private constructor(
    private readonly db: IdbDatabaseLike | null,
    private readonly onFallback: ((fallback: CacheFallback) => void) | undefined,
  ) {}

  /** The database name of an account's cache. */
  static databaseName(accountId: string): string {
    return `knowtarium-cache-${AccountId.parse(accountId)}`;
  }

  /**
   * Opens (or creates) an account's cache. Never rejects for IndexedDB itself: if it can't be
   * opened, the adapter runs in memory and reports `unavailable`.
   */
  static async open(
    factory: IdbFactoryLike,
    options: {
      readonly accountId: string;
      /** Told once when the cache falls back to memory. */
      readonly onFallback?: (fallback: CacheFallback) => void;
    },
  ): Promise<IndexedDbCacheAdapter> {
    const name = IndexedDbCacheAdapter.databaseName(options.accountId);
    try {
      const db = await openStore(factory, name, STORE);
      return new IndexedDbCacheAdapter(db, options.onFallback);
    } catch (error) {
      const adapter = new IndexedDbCacheAdapter(null, options.onFallback);
      adapter.fallBack({ reason: isQuotaError(error) ? "quota" : "unavailable", error });
      return adapter;
    }
  }

  /** Why the cache runs in memory, or null while it uses IndexedDB. */
  get fallback(): CacheFallback | null {
    return this.reported;
  }

  private fallBack(fallback: CacheFallback): MemoryCacheAdapter {
    if (this.memory === null) {
      this.memory = new MemoryCacheAdapter();
      this.reported = fallback;
      try {
        this.onFallback?.(fallback);
      } catch {
        // a broken listener must not break the cache
      }
    }
    return this.memory;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    checkKey(key);
    if (this.memory !== null || this.db === null) return this.fallBack(this.unavailable()).get(key);
    const transaction = this.db.transaction(STORE, "readonly");
    const value = await requestResult(transaction.objectStore(STORE).get(key));
    return value instanceof Uint8Array ? value.slice() : undefined;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    checkKey(key);
    if (this.memory !== null || this.db === null) {
      await this.fallBack(this.unavailable()).put(key, value);
      return;
    }
    try {
      const transaction = this.db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(value.slice(), key);
      await transactionDone(transaction);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      // full: this session carries on in memory, starting with this write
      await this.fallBack({ reason: "quota", error }).put(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    if (this.memory !== null) await this.memory.delete(key);
    if (this.db === null) return;
    const transaction = this.db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(key);
    await transactionDone(transaction);
  }

  async list(prefix: string): Promise<string[]> {
    if (this.memory !== null || this.db === null) {
      return this.fallBack(this.unavailable()).list(prefix);
    }
    const transaction = this.db.transaction(STORE, "readonly");
    const keys = (await requestResult(transaction.objectStore(STORE).getAllKeys())) as unknown[];
    return keys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix));
  }

  /** Forgets everything cached for one workspace (sign-out from it, a revoked token). */
  async clearWorkspace(workspaceId: string): Promise<void> {
    const prefix = `ws/${WorkspaceId.parse(workspaceId)}/`;
    if (this.memory !== null) {
      for (const key of await this.memory.list(prefix)) await this.memory.delete(key);
    }
    if (this.db === null) return;
    const read = this.db.transaction(STORE, "readonly");
    const keys = (await requestResult(read.objectStore(STORE).getAllKeys())) as unknown[];
    const transaction = this.db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const key of keys) {
      if (typeof key === "string" && key.startsWith(prefix)) store.delete(key);
    }
    await transactionDone(transaction);
  }

  /** Forgets the whole cache of this account (sign-out). */
  async clearAll(): Promise<void> {
    if (this.memory !== null) {
      for (const key of await this.memory.list("")) await this.memory.delete(key);
    }
    if (this.db === null) return;
    const transaction = this.db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await transactionDone(transaction);
  }

  /** Closes the database connection. */
  close(): void {
    this.db?.close();
  }

  /** The fallback reason when there is no database at all. */
  private unavailable(): CacheFallback {
    return this.reported ?? { reason: "unavailable", error: null };
  }
}
