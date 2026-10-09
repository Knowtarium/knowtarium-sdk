import { join } from "node:path";

import type { TrustStorage } from "../../client/index.js";
import { readIfExists, writePrivateFile } from "./files.js";
import { withFileLock } from "./lock.js";

function parse(bytes: Uint8Array | null): Map<string, string> {
  let parsed: unknown = {};
  if (bytes !== null) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("trust.json in the Knowtarium folder is damaged; it can't be read.");
    }
  }
  return new Map(
    Object.entries(typeof parsed === "object" && parsed !== null ? parsed : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * The rollback marks on disk (`trust.json` in the CLI's folder): pinned public keys and
 * high-water numbers, nothing secret. Every read and write goes to the file (it is small), and
 * each write re-reads it under an advisory lock, so two CLI processes (say `connect` and a
 * running `mcp`) don't drop each other's marks. Writes are atomic.
 */
export class FileTrustStorage implements TrustStorage {
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, "trust.json");
  }

  private async current(): Promise<Map<string, string>> {
    return parse(await readIfExists(this.path));
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.current()).get(key);
  }

  set(key: string, value: string): Promise<void> {
    return this.change((values) => values.set(key, value));
  }

  delete(key: string): Promise<void> {
    return this.change((values) => values.delete(key));
  }

  /** Re-reads the file, applies one change and writes it back, one change at a time. */
  private change(apply: (values: Map<string, string>) => void): Promise<void> {
    const next = this.writing.then(() =>
      withFileLock(this.path, async () => {
        const values = await this.current();
        apply(values);
        await writePrivateFile(this.path, JSON.stringify(Object.fromEntries(values), null, 1));
      }),
    );
    this.writing = next.catch(() => undefined);
    return next;
  }
}
