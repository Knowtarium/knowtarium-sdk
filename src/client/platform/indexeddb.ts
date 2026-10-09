// The slice of IndexedDB the client's stores use, typed by hand (`src/` has no DOM types). The
// browser's `indexedDB` fits `IdbFactoryLike`. Handlers are assigned as properties, which the
// browser's request objects accept.

export interface IdbRequestLike {
  readonly result: unknown;
  readonly error: unknown;
  onsuccess: unknown;
  onerror: unknown;
}

export interface IdbOpenRequestLike extends IdbRequestLike {
  onupgradeneeded: unknown;
}

export interface IdbStoreLike {
  get(key: string): IdbRequestLike;
  put(value: unknown, key: string): IdbRequestLike;
  delete(key: string): IdbRequestLike;
  getAllKeys(): IdbRequestLike;
  clear(): IdbRequestLike;
}

export interface IdbTransactionLike {
  objectStore(name: string): IdbStoreLike;
  readonly error: unknown;
  oncomplete: unknown;
  onerror: unknown;
  onabort: unknown;
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(storeNames: string, mode: "readonly" | "readwrite"): IdbTransactionLike;
  close(): void;
}

/** The browser's `indexedDB` (an `IDBFactory`). */
export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

/** Opens (or creates) a database with one object store. */
export async function openStore(
  factory: IdbFactoryLike,
  name: string,
  store: string,
): Promise<IdbDatabaseLike> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => {
    const db = request.result as IdbDatabaseLike;
    if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
  };
  return (await requestResult(request)) as IdbDatabaseLike;
}

/** A request's result, or its error. */
export function requestResult(request: IdbRequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        request.error instanceof Error ? request.error : new Error("IndexedDB request failed"),
      );
    };
  });
}

/** Settles when a transaction commits, or rejects with why it failed or aborted. */
export function transactionDone(transaction: IdbTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    const fail = () => {
      reject(
        transaction.error instanceof Error
          ? transaction.error
          : new Error("IndexedDB write failed"),
      );
    };
    transaction.onerror = fail;
    transaction.onabort = fail;
  });
}
