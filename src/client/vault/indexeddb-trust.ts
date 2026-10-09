import {
  type IdbDatabaseLike,
  type IdbFactoryLike,
  openStore,
  requestResult,
  transactionDone,
} from "../platform/indexeddb.js";

import type { TrustStorage } from "./trust.js";

export type { IdbFactoryLike };

const STORE = "marks";

/**
 * A `TrustStorage` in the browser's IndexedDB, so the web app's rollback marks outlive a reload.
 * It holds only what `TrustState` writes: pinned public keys and high-water numbers (KDF
 * parameters, key generations, note versions), none of it secret. The CLI keeps the same marks in
 * a file of its own instead.
 */
export class IndexedDbTrustStorage implements TrustStorage {
  private constructor(private readonly db: IdbDatabaseLike) {}

  /** Opens (or creates) the database, one per account is a good choice: `knowtarium-trust-<id>`. */
  static async open(
    factory: IdbFactoryLike,
    name = "knowtarium-trust",
  ): Promise<IndexedDbTrustStorage> {
    const db = await openStore(factory, name, STORE);
    return new IndexedDbTrustStorage(db);
  }

  async get(key: string): Promise<string | undefined> {
    const transaction = this.db.transaction(STORE, "readonly");
    const value = await requestResult(transaction.objectStore(STORE).get(key));
    return typeof value === "string" ? value : undefined;
  }

  set(key: string, value: string): Promise<void> {
    const transaction = this.db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(value, key);
    return transactionDone(transaction);
  }

  delete(key: string): Promise<void> {
    const transaction = this.db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(key);
    return transactionDone(transaction);
  }

  /** Closes the database connection. */
  close(): void {
    this.db.close();
  }
}
