import { parseNote } from "../note/index.js";
import { isReservedFile } from "../spec.js";
import { fileText, isHidden, isNotePath } from "./files.js";
import type { PreparedFile } from "./prepare.js";

/** How the import reads the bundle, and why. */
export interface Detected {
  readonly source: "okf" | "obsidian";
  readonly reason: string;
}

/** Whether the bundle is already OKF: a readable root `index.md` and a `type` on every other note. */
function alreadyOkf(files: readonly PreparedFile[]): boolean {
  const index = files.find((file) => file.path.toLowerCase() === "index.md");
  const indexText = index === undefined ? null : fileText(index.data);
  if (indexText === null || parseNote(indexText).problems.length > 0) return false;
  return files
    .filter((file) => isNotePath(file.path) && !isHidden(file.path) && !isReservedFile(file.path))
    .every((file) => {
      const text = fileText(file.data);
      return text !== null && "type" in (parseNote(text).frontmatter?.data ?? {});
    });
}

/**
 * Decides how to read the bundle. `okf` and `obsidian` are the caller's choice; `auto` converts
 * a bundle as an Obsidian vault only when it has a `.obsidian/` folder at its root (a settings
 * file, or `obsidianFolder` when the caller saw the folder itself) and isn't
 * already OKF (a root `index.md` and a `type` on every note), and takes anything else as OKF.
 */
export function detectSource(
  files: readonly PreparedFile[],
  requested: "auto" | "okf" | "obsidian",
  obsidianFolder = false,
): Detected {
  if (requested !== "auto") return { source: requested, reason: "Chosen by the importer." };
  if (!obsidianFolder && !files.some((file) => file.path.startsWith(".obsidian/"))) {
    return { source: "okf", reason: "No .obsidian folder at the root: taken as an OKF bundle." };
  }
  if (alreadyOkf(files)) {
    return {
      source: "okf",
      reason:
        "An Obsidian vault already in OKF form (a root index.md and a type on every note): taken as it is.",
    };
  }
  return {
    source: "obsidian",
    reason: "An Obsidian vault (a .obsidian folder at the root): converted by the migration rules.",
  };
}
