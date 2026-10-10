import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BUSY_RETRY_MS,
  ensurePrivateDir,
  isWindowsBusy,
  removeFile,
  retryWhileBusy,
  sleep,
} from "./files.js";

/** A lock older than this was left by a process that died; it is broken. */
const STALE_MS = 30_000;
const TIMEOUT_MS = 10_000;

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

/**
 * A lock's content, or null when it can't be read (gone, or on Windows being deleted). With
 * `until`, a Windows busy error is retried until then: a holder releasing its own lock must not
 * leave it behind over a moment's EPERM.
 */
const readLock = (lock: string, until?: number) =>
  (until === undefined
    ? readFile(lock, "utf8")
    : retryWhileBusy(() => readFile(lock, "utf8"), until)
  ).catch(() => null);

/** How long a breaker may hold the break guard before another takes it from it. */
const GUARD_STALE_MS = 2_000;

/**
 * Breaks a lock left by a holder that is gone (or older than `staleMs`), so that of several
 * processes breaking it at once only one does, and none ever removes a live lock: breakers take
 * turns through a guard file (`<lock>.break`, created exclusively, held for the few milliseconds
 * of a check and a removal), and under it the lock is removed only if it still holds exactly the
 * content judged dead. Only breakers remove a dead holder's lock, so it can't have been replaced
 * between that check and the removal. A guard left by a breaker that died mid-way is taken after
 * two seconds. Each guard holds a token of its own (`<pid>:<uuid>`): a breaker removes a stale
 * guard only if it still holds the token it judged stale, and its own guard only if it still holds
 * its token, so a guard another breaker has taken since stays (short of the moment between that
 * last read and the removal).
 *
 * On Windows a guard or lock another process has just removed can't be created or removed for a
 * moment (EPERM, EACCES or EBUSY). Creating the guard or removing a stale one that way counts as
 * another breaker being at it. Under the guard, removals are retried only for the first half of
 * `GUARD_STALE_MS`: a breaker still retrying once its guard could count as stale might remove a
 * lock that another breaker's waiter has taken since. Still busy then, it gives up and looks
 * again. Resolves to true when this call held the guard and the dead lock is gone or changed (the
 * caller tries to take it again at once), false otherwise (the caller waits a little first).
 */
async function breakLock(lock: string, dead: string): Promise<boolean> {
  const guard = `${lock}.break`;
  const guardTakenAt = Date.now();
  const ours = `${String(process.pid)}:${randomUUID()}`;
  try {
    const handle = await open(guard, "wx", 0o600);
    await handle.writeFile(ours);
    await handle.close();
  } catch (error) {
    if (isWindowsBusy(error)) return false;
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // the same token before and after the stat: the guard judged stale is the one read
    const held = await readLock(guard);
    const info = held === null ? null : await stat(guard).catch(() => null);
    if (
      info !== null &&
      Date.now() - info.mtimeMs > GUARD_STALE_MS &&
      (await readLock(guard)) === held
    ) {
      // not retried: busy means another breaker is removing it already
      await rm(guard, { force: true }).catch((removal: unknown) => {
        if (!isWindowsBusy(removal)) throw removal;
      });
    }
    return false; // another breaker is at it: look again
  }
  const until = guardTakenAt + GUARD_STALE_MS / 2;
  const unlessBusy = (error: unknown) => {
    if (!isWindowsBusy(error)) throw error;
    // still busy at the bound: look again (a guard left behind is taken as stale later)
    return false;
  };
  try {
    if ((await readLock(lock)) !== dead) return true;
    return await removeFile(lock, until).then(() => true, unlessBusy);
  } finally {
    // only our own guard: one taken from us as stale (we were too slow) is another breaker's now
    if ((await readLock(guard, until)) === ours) await removeFile(guard, until).catch(unlessBusy);
  }
}

/** Whether a lock this process couldn't release was reported already (once is enough). */
let releaseReported = false;

/**
 * Runs `run` while holding an advisory lock on `path` (a `<path>.lock` file created exclusively,
 * holding `<pid>:<token>`), so two CLI processes (a running `mcp` and a `connect`, say) never
 * interleave their read-modify-write of the same file. A lock whose process is gone is broken at
 * once, any other after 30 seconds (`breakLock`, one breaker at a time, never a live lock);
 * waiting longer than 10 seconds fails with a message naming the lock file. On release only this
 * process's own lock is removed.
 *
 * On Windows a lock file another process has just removed stays "delete pending" until every
 * handle on it closes, and creating it again meanwhile fails with EPERM (sometimes EACCES or
 * EBUSY) instead of EEXIST. That is waited out like a held lock, within the same deadline, and
 * never breaks a lock; if it lasts past the deadline, the error names the code and the folder.
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
  const staleMs = options.staleMs ?? STALE_MS;
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  let takenAt: number;
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      takenAt = Date.now();
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(mine);
      await handle.close();
      break;
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      // on Windows, a lock file being deleted: waited for like a held lock, never broken over it
      const busy = isWindowsBusy(error);
      if (!busy && code !== "EEXIST") throw error;
      if (!busy) {
        const [info, content] = await Promise.all([stat(lock).catch(() => null), readLock(lock)]);
        if (
          info !== null &&
          content !== null &&
          (Date.now() - info.mtimeMs > staleMs || holderGone(content)) &&
          (await breakLock(lock, content))
        ) {
          continue;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          busy
            ? `Couldn't create ${lock}: Windows kept answering ${code}. Check that ` +
                `${dirname(lock)} is writable and that no other program holds that file.`
            : `Another knowtarium process is writing ${path}. If none is running, delete ${lock}.`,
          { cause: error },
        );
      }
      await sleep(wait);
    }
  }
  try {
    return await run();
  } finally {
    // only our own lock: a lock broken meanwhile (we were too slow) belongs to someone else now.
    // A busy read or removal (Windows) is retried, but stops well before the lock could count as
    // stale (30 s): after that a breaker may have replaced it with another holder's lock. A lock
    // still there then never replaces `run`'s result or error: the next process breaks it once
    // this one has exited, or once it is stale.
    const until = Math.min(Date.now() + BUSY_RETRY_MS, takenAt + staleMs - BUSY_RETRY_MS);
    try {
      if ((await readLock(lock, until)) === mine) await removeFile(lock, until);
    } catch (error) {
      if (!releaseReported) {
        releaseReported = true;
        const code = (error as NodeJS.ErrnoException).code ?? String(error);
        process.stderr.write(
          `knowtarium: couldn't remove ${lock} (${code}); it counts as free once this process exits, or after ${String(Math.round(staleMs / 1000))} seconds.\n`,
        );
      }
    }
  }
}
