import { normalizePath } from "../path/index.js";
import { fileText } from "./files.js";
import type { PreparedFile } from "./prepare.js";

/** The folders an Obsidian vault's settings reserve for daily notes and templates. */
export interface ObsidianFolders {
  readonly daily: readonly string[];
  readonly templates: readonly string[];
}

function folderSetting(files: readonly PreparedFile[], path: string, key: string): string[] {
  const entry = files.find((candidate) => candidate.path === path);
  const text = entry === undefined ? null : fileText(entry.data);
  if (text === null) return [];
  try {
    const value = (JSON.parse(text) as Record<string, unknown> | null)?.[key];
    return typeof value === "string" && value.trim() !== ""
      ? [normalizePath(value.replace(/^\/+/, ""))]
      : [];
  } catch {
    return [];
  }
}

/**
 * Reads where the vault keeps daily notes and templates: the core Daily notes and Templates
 * plugins (`.obsidian/daily-notes.json`, `.obsidian/templates.json`) and the Templater plugin, at
 * exactly those paths in the vault's root.
 */
export function obsidianFolders(files: readonly PreparedFile[]): ObsidianFolders {
  return {
    daily: folderSetting(files, ".obsidian/daily-notes.json", "folder"),
    templates: [
      ...folderSetting(files, ".obsidian/templates.json", "folder"),
      ...folderSetting(files, ".obsidian/plugins/templater-obsidian/data.json", "templates_folder"),
    ],
  };
}

/** Whether a path is inside one of `folders`, ignoring letter case as Obsidian's settings do. */
export function isInside(path: string, folders: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return folders.some((folder) => {
    const prefix = folder.toLowerCase();
    return lower === prefix || lower.startsWith(`${prefix}/`);
  });
}
