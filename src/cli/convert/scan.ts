import { type Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BundleFile } from "../../core/index.js";

/** Something the walk didn't read, and why. */
export interface WalkSkip {
  readonly path: string;
  readonly reason: string;
}

/** The vault as read: its files, what was left unread, and what to warn about. */
export interface ScannedVault {
  readonly files: BundleFile[];
  readonly skipped: WalkSkip[];
  /** Files with other hard links: the copy is independent of the other names. */
  readonly hardLinked: WalkSkip[];
}

/** The `.obsidian` files the conversion reads (attachment, daily-note and template settings). */
function wantedSetting(path: string): boolean {
  return (
    /^\.obsidian\/[^/]+\.json$/.test(path) ||
    path === ".obsidian/plugins/templater-obsidian/data.json"
  );
}

/** The largest vault read (4 GiB) and the most files (200,000), checked from sizes before reading. */
export const VAULT_LIMITS = { maxBytes: 4 * 1024 * 1024 * 1024, maxFiles: 200_000 } as const;

/**
 * Reads a vault for the conversion without following anything out of it: symlinks are skipped
 * and reported, so are folders it can't read (it carries on). Hidden folders (`.git`, `.trash`
 * and the like) aren't read at all, hidden files neither; of `.obsidian` only the settings the
 * conversion needs. Sizes come from `lstat` first, and a vault over the limits is refused before
 * any file is read.
 */
export async function scanVault(root: string): Promise<ScannedVault> {
  const skipped: WalkSkip[] = [];
  const hardLinked: WalkSkip[] = [];
  const found: { path: string; size: number }[] = [];
  const note = async (path: string) => {
    const info = await lstat(join(root, path));
    if (info.nlink > 1) {
      hardLinked.push({
        path,
        reason: `Has ${String(info.nlink - 1)} other hard link(s); the copy is a separate file.`,
      });
    }
    found.push({ path, size: info.size });
  };
  const walk = async (folder: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, folder), { withFileTypes: true });
    } catch (error) {
      skipped.push({
        path: folder === "" ? "." : folder,
        reason: `Couldn't be read (${(error as NodeJS.ErrnoException).code ?? "error"}), so nothing in it was converted.`,
      });
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: "A symbolic link: not followed and not copied." });
        continue;
      }
      const hidden = entry.name.startsWith(".");
      if (entry.isDirectory()) {
        if (
          hidden &&
          !(prefix === "" && entry.name === ".obsidian") &&
          !path.startsWith(".obsidian/")
        ) {
          skipped.push({ path: `${path}/`, reason: "A hidden folder: not read." });
          continue;
        }
        await walk(path, path);
      } else if (entry.isFile()) {
        if (path.startsWith(".obsidian/")) {
          if (wantedSetting(path)) await note(path);
          continue;
        }
        if (hidden) {
          skipped.push({ path, reason: "A hidden file: not read." });
          continue;
        }
        await note(path);
      } else {
        skipped.push({ path, reason: "Not a regular file (a socket, pipe or device): not read." });
      }
    }
  };
  await walk("", "");
  const bytes = found.reduce((sum, file) => sum + file.size, 0);
  if (found.length > VAULT_LIMITS.maxFiles || bytes > VAULT_LIMITS.maxBytes) {
    throw new Error(
      `The vault is too large to convert at once (${String(found.length)} files, ${String(Math.round(bytes / 1024 / 1024))} MiB; the limit is ${String(VAULT_LIMITS.maxFiles)} files and 4 GiB).`,
    );
  }
  const files: BundleFile[] = [];
  for (const file of found) {
    try {
      files.push({ path: file.path, data: new Uint8Array(await readFile(join(root, file.path))) });
    } catch (error) {
      skipped.push({
        path: file.path,
        reason: `Couldn't be read (${(error as NodeJS.ErrnoException).code ?? "error"}), so it was left out.`,
      });
    }
  }
  return { files, skipped, hardLinked };
}
