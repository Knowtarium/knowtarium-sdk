import { type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { OutputWriter } from "./output.js";
import type { WalkSkip } from "./scan.js";

/**
 * Copies the vault's `.obsidian` settings folder next to the converted bundle, so Obsidian opens
 * the copy as it opened the vault: folders and regular files only, written through the output's
 * `OutputWriter` (never overwriting, never through a link), never following or recreating
 * symbolic links (they are skipped and reported, like anything it can't read).
 */
export async function copySettings(vaultReal: string, writer: OutputWriter): Promise<WalkSkip[]> {
  const skipped: WalkSkip[] = [];
  const copy = async (relative: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(vaultReal, relative), { withFileTypes: true });
    } catch (error) {
      skipped.push({
        path: `${relative}/`,
        reason: `Couldn't be read (${(error as NodeJS.ErrnoException).code ?? "error"}), so it wasn't copied.`,
      });
      return;
    }
    await writer.folder(relative);
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: "A symbolic link in Obsidian's settings: not copied." });
      } else if (entry.isDirectory()) {
        await copy(path);
      } else if (entry.isFile()) {
        let data: Uint8Array;
        try {
          data = new Uint8Array(await readFile(join(vaultReal, path)));
        } catch (error) {
          skipped.push({
            path,
            reason: `Couldn't be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
          });
          continue;
        }
        await writer.file(path, data);
      } else {
        skipped.push({ path, reason: "Not a regular file: not copied." });
      }
    }
  };
  const top = await readdir(vaultReal, { withFileTypes: true }).catch(() => []);
  const settings = top.find((entry) => entry.name === ".obsidian");
  if (settings?.isDirectory() === true) await copy(".obsidian");
  else if (settings?.isSymbolicLink() === true) {
    skipped.push({
      path: ".obsidian",
      reason: "A symbolic link: Obsidian's settings weren't copied.",
    });
  }
  return skipped;
}
