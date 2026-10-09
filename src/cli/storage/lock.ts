import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { ensurePrivateDir } from "./files.js";

/** A lock older than this was left by a process that died; it is broken. */
const STALE_MS = 30_000;
const TIMEOUT_MS = 10_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Whether the process that wrote a lock is gone: the lock holds `<pid>:<token>`, and no process
 * has that PID any more. An agent that stops its MCP server abruptly leaves its lock behind, and
 * the next server must not wait for it (that cost agents half a minute at start-up).
 */
function holderGone(content: string): boolean {
  const pid = Number.parseInt(content.split(":")[0] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM: it exists, under another user
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const readLock = (lock: string) => readFile(lock, "utf8").catch(() => null);

/** How long a breaker may hold the break guard before another takes it from it. */
const GUARD_STALE_MS = 2_000;

/**
 * Breaks a lock left by a holder that is gone (or older than `staleMs`), so that of several
 * processes breaking it at once only one does, and none ever removes a live lock: breakers take
 * turns through a guard file (`<lock>.break`, created exclusively, held for the few milliseconds
 * of a check and a removal), and under it the lock is removed only if it still holds exactly the
 * content judged dead. Only breakers remove a dead holder's lock, so it can't have been replaced
 * between that check and the removal. A guard left by a breaker that died mid-way is taken after
 * two seconds. Resolves when the caller should try to take the lock again.
 */
async function breakLock(lock: string, dead: string): Promise<void> {
  const guard = `${lock}.break`;
  try {
    const handle = await open(guard, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await stat(guard).catch(() => null);
    if (info !== null && Date.now() - info.mtimeMs > GUARD_STALE_MS) {
      await rm(guard, { force: true });
    }
    return; // another breaker is at it: look again
  }
  try {
    if ((await readLock(lock)) === dead) await rm(lock, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

/**
 * Runs `run` while holding an advisory lock on `path` (a `<path>.lock` file created exclusively,
 * holding `<pid>:<token>`), so two CLI processes (a running `mcp` and a `connect`, say) never
 * interleave their read-modify-write of the same file. A lock whose process is gone is broken at
 * once, any other after 30 seconds (`breakLock`, one breaker at a time, never a live lock);
 * waiting longer than 10 seconds fails with a message naming the lock file. On release only this
 * process's own lock is removed.
 */
export async function withFileLock<T>(
  path: string,
  run: () => Promise<T>,
  options: { readonly timeoutMs?: number; readonly staleMs?: number } = {},
): Promise<T> {
  const lock = `${path}.lock`;
  await ensurePrivateDir(dirname(path));
  const token = randomUUID();
  const mine = `${String(process.pid)}:${token}`;
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(mine);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const [info, content] = await Promise.all([stat(lock).catch(() => null), readLock(lock)]);
      if (
        info !== null &&
        content !== null &&
        (Date.now() - info.mtimeMs > (options.staleMs ?? STALE_MS) || holderGone(content))
      ) {
        await breakLock(lock, content);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Another knowtarium process is writing ${path}. If none is running, delete ${lock}.`,
          { cause: error },
        );
      }
      await sleep(wait);
    }
  }
  try {
    return await run();
  } finally {
    // only our own lock: a lock broken meanwhile (we were too slow) belongs to someone else now
    if ((await readLock(lock)) === mine) await rm(lock, { force: true });
  }
}
