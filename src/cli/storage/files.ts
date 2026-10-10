import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/** What Windows answers for a moment while another process deletes, renames or reads a file. */
const WINDOWS_BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/** How long a file operation retries while Windows says the file is busy. */
export const BUSY_RETRY_MS = 5_000;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Whether an error is Windows refusing a file for a moment: opening or creating a file that
 * another process has just deleted (it stays "delete pending" until every handle on it closes),
 * renaming over a file another process has open, or a virus scanner holding it. Windows answers
 * EPERM, EACCES or EBUSY, the same codes as a real permission error, so callers retry only until
 * a deadline and then report the error. Never true elsewhere, where these codes mean what they say.
 */
export function isWindowsBusy(error: unknown): boolean {
  return (
    process.platform === "win32" &&
    WINDOWS_BUSY.has((error as NodeJS.ErrnoException | null)?.code ?? "")
  );
}

/**
 * Runs a file operation, running it again with a growing pause (10 ms up to 250 ms) while it
 * fails with `isWindowsBusy`, until `until` (a `Date.now()` time, by default `BUSY_RETRY_MS` from
 * now). Any other error, or the busy error still there at the deadline, is thrown as it is.
 */
export async function retryWhileBusy<T>(
  operation: () => Promise<T>,
  until = Date.now() + BUSY_RETRY_MS,
): Promise<T> {
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      return await operation();
    } catch (error) {
      if (!isWindowsBusy(error) || Date.now() + wait > until) throw error;
      await sleep(wait);
    }
  }
}

/** Removes a file if it exists, retrying while Windows says it is busy (see `retryWhileBusy`). */
export function removeFile(path: string, until?: number): Promise<void> {
  return retryWhileBusy(() => rm(path, { force: true }), until);
}

/** Creates a folder (and its parents) readable only by the user. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * Writes a file atomically (a temporary file in the same folder, then a rename), readable and
 * writable only by the user, so a crash never leaves half a file behind. On Windows the rename
 * fails while another process reads or replaces the same file, so it is retried for a while: the
 * CLI's own files are written under `withFileLock` or under a fresh name, so nothing written
 * meanwhile is lost.
 */
export function writePrivateFile(
  path: string,
  data: Uint8Array | string,
  mode = 0o600,
): Promise<void> {
  return writeAtomically(path, data, mode, true);
}

async function writeAtomically(
  path: string,
  data: Uint8Array | string,
  mode: number,
  retryRename: boolean,
): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, data, { mode });
    await (retryRename ? retryWhileBusy(() => rename(temporary, path)) : rename(temporary, path));
    await chmod(path, mode).catch(() => undefined);
  } catch (error) {
    // the write's own error is the one to report
    await removeFile(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * A file's bytes, or null when it doesn't exist. On Windows a file another process is deleting
 * can't be opened until it is gone, so that is retried for a while: once it is gone it reads as
 * missing; still busy after that, the error is reported.
 */
export async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await retryWhileBusy(() => readFile(path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Writes a file atomically, keeping the mode of the file it replaces (0600 for a new one). A
 * symlink is resolved first, so the link survives and its target gets the new content. The
 * rename is not retried when Windows refuses it: the file belongs to another app (an agent's
 * config), which may be saving it right then, and a later rename would overwrite that save.
 */
export async function replaceFile(path: string, data: Uint8Array | string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o600,
  );
  await writeAtomically(target, data, mode, false);
}

/**
 * Every regular file under a folder, as `/`-separated paths relative to it (symlinks and other
 * special files left out). A plain walk, so it needs no recursive `readdir` or
 * `Dirent.parentPath`, which older Node versions lack.
 */
export async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(folder, entry.name), path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(root, "");
  return files;
}
