import type { CacheAdapter } from "../../client/index.js";

/**
 * A cache adapter that can stop writing for a workspace: once a running `mcp` sees that its
 * workspace was disconnected (the cache wiped), nothing it still has in flight writes the cache
 * again. Reads go through.
 */
export class GuardedCacheAdapter implements CacheAdapter {
  private readonly stopped = new Set<string>();

  constructor(private readonly inner: CacheAdapter) {}

  /** Drops every later write under the workspace's prefix. */
  stop(workspaceId: string): void {
    this.stopped.add(`ws/${workspaceId}/`);
  }

  private blocked(key: string): boolean {
    for (const prefix of this.stopped) if (key.startsWith(prefix)) return true;
    return false;
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.inner.get(key);
  }

  put(key: string, value: Uint8Array): Promise<void> {
    return this.blocked(key) ? Promise.resolve() : this.inner.put(key, value);
  }

  delete(key: string): Promise<void> {
    return this.blocked(key) ? Promise.resolve() : this.inner.delete(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }
}
