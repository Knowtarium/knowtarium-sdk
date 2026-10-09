/**
 * Where the encrypted cache keeps its bytes: IndexedDB in the browser, files in the CLI, memory in
 * tests. Keys are `/`-separated paths made of IDs only; values are ciphertext envelopes or small
 * JSON records of IDs and numbers, never plaintext.
 */
export interface CacheAdapter {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key that starts with `prefix`, in any order. */
  list(prefix: string): Promise<string[]>;
}

/** A `CacheAdapter` in memory. It copies values in and out, like a real store would. */
export class MemoryCacheAdapter implements CacheAdapter {
  private readonly values = new Map<string, Uint8Array>();

  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.values.get(key)?.slice());
  }

  put(key: string, value: Uint8Array): Promise<void> {
    this.values.set(key, value.slice());
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.values.keys()].filter((key) => key.startsWith(prefix)));
  }

  /** Every stored value, for tests that check nothing readable was written. */
  entries(): [string, Uint8Array][] {
    return [...this.values.entries()].map(([key, value]) => [key, value.slice()]);
  }
}
