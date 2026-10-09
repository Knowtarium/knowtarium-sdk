import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { CacheAdapter } from "../../client/index.js";
import { listFiles, readIfExists, writePrivateFile } from "./files.js";

const SEGMENT = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The encrypted cache's `CacheAdapter` on disk: one file per key under the cache folder, written
 * atomically and readable only by the user. It only ever holds what `EncryptedCache` gives it
 * (ciphertext envelopes, IDs, versions, cursors), and refuses keys that could leave the folder.
 */
export class FileCacheAdapter implements CacheAdapter {
  constructor(private readonly root: string) {}

  private pathOf(key: string): string {
    const segments = key.split("/");
    if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) {
      throw new Error(`invalid cache key ${JSON.stringify(key)}`);
    }
    return join(this.root, ...segments);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return (await readIfExists(this.pathOf(key))) ?? undefined;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await writePrivateFile(this.pathOf(key), value);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    try {
      return (await listFiles(this.root)).filter(
        (key) => key.startsWith(prefix) && !key.split("/").some((part) => part.startsWith(".")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
