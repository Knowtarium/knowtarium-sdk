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

/** Creates a folder (and its parents) readable only by the user. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * Writes a file atomically (a temporary file in the same folder, then a rename), readable and
 * writable only by the user, so a crash never leaves half a file behind.
 */
export async function writePrivateFile(
  path: string,
  data: Uint8Array | string,
  mode = 0o600,
): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, data, { mode });
    await rename(temporary, path);
    await chmod(path, mode).catch(() => undefined);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** A file's bytes, or null when it doesn't exist. */
export async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Writes a file atomically, keeping the mode of the file it replaces (0600 for a new one). A
 * symlink is resolved first, so the link survives and its target gets the new content.
 */
export async function replaceFile(path: string, data: Uint8Array | string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o600,
  );
  await writePrivateFile(target, data, mode);
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
