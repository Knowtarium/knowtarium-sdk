// A CLI context over temporary folders, an in-memory secret store and the client's fake server,
// for the CLI tests. Not shipped.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchLike } from "../../client/index.js";
import { type CliContext, makeCliContext } from "../context.js";
import { cliEnvironment } from "../env.js";
import type { CliIo } from "../io.js";
import { MemorySecretStore } from "../storage/secret-store.js";

/** Terminal output captured, with scripted answers to questions. */
export class TestIo implements CliIo {
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  readonly opened: string[] = [];
  answers: boolean[] = [];
  /** What each checkbox list returns, in turn; null (the default) is "no terminal". */
  choices: (number[] | null)[] = [];
  /** The labels of every checkbox list shown. */
  readonly offered: (readonly string[])[] = [];
  /** The lines each list started unticked. */
  readonly unticked: (readonly number[])[] = [];
  interactive = true;
  onOpen: ((url: string) => void) | undefined;

  out(line: string): void {
    this.lines.push(line);
  }

  err(line: string): void {
    this.errors.push(line);
  }

  confirm(): Promise<boolean> {
    return Promise.resolve(this.answers.shift() ?? false);
  }

  choose(
    _question: string,
    labels: readonly string[],
    unticked: readonly number[] = [],
  ): Promise<number[] | null> {
    this.offered.push(labels);
    this.unticked.push(unticked);
    return Promise.resolve(this.choices.shift() ?? null);
  }

  openUrl(url: string): Promise<void> {
    this.opened.push(url);
    this.onOpen?.(url);
    return Promise.resolve();
  }
}

/** A fresh temporary folder, removed by `cleanup`. */
export async function temporaryFolder(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "knowtarium-cli-"));
  // retried: a session stopping meanwhile may still be finishing a cache write
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}

/** A context whose home, cache and user home all live in `folder`, with secrets in memory. */
export function testContext(
  folder: string,
  fetch: FetchLike,
  io = new TestIo(),
): CliContext & { io: TestIo; memorySecrets: MemorySecretStore } {
  const env = cliEnvironment(
    {
      KNOWTARIUM_API_URL: "https://api.test",
      KNOWTARIUM_APP_URL: "https://app.test",
      KNOWTARIUM_HOME: join(folder, "home"),
      KNOWTARIUM_CACHE: join(folder, "cache"),
    },
    "linux",
    join(folder, "user"),
  );
  const memorySecrets = new MemorySecretStore();
  const context = makeCliContext({
    env,
    io,
    fetch,
    version: "0.0.0",
    openSecrets: () => Promise.resolve(memorySecrets),
  });
  return { ...context, io, memorySecrets };
}
