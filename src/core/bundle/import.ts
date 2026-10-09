import { setBody } from "../frontmatter/index.js";
import { parseNote } from "../note/index.js";
import { fileNameOf, folderOf, joinPath, stemOf } from "../path/index.js";
import { collect, type Collected, type CollectedFile, sortedFolders } from "./collect.js";
import { type Detected, detectSource } from "./detect.js";
import { HISTORY_FOLDER } from "./export.js";
import { fileText, isHidden } from "./files.js";
import { folderIndex, foldersWithIndex, logWithEntry } from "./indexes.js";
import { isInside, obsidianFolders } from "./obsidian-config.js";
import { rewriteObsidianLinks } from "./obsidian-links.js";
import { addOkfFields } from "./okf-fields.js";
import { checkLimits, type Prepared, prepareFiles, type PreparedFile } from "./prepare.js";
import type {
  BundleFile,
  ImportedAttachment,
  ImportedNote,
  ImportOptions,
  ImportReport,
  ImportResult,
} from "./types.js";
import { Vault, type VaultEntry } from "./vault.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };

/** Past versions a Knowtarium export wrote: left out, reported once rather than file by file. */
function historySkip(files: readonly PreparedFile[]): {
  rest: PreparedFile[];
  skipped: { path: string; reason: string }[];
} {
  const prefix = `${HISTORY_FOLDER}/`;
  const rest = files.filter((file) => !file.path.startsWith(prefix));
  const count = files.length - rest.length;
  return {
    rest,
    skipped:
      count === 0
        ? []
        : [
            {
              path: prefix,
              reason: `${String(count)} past versions from an export, not imported.`,
            },
          ],
  };
}

function newReport(
  detected: Detected,
  prepared: Prepared,
  collected: Collected,
  history: { path: string; reason: string }[],
): Mutable<ImportReport> {
  return {
    source: detected.source,
    sourceReason: detected.reason,
    root: prepared.root,
    notes: 0,
    attachments: 0,
    renamed: [...prepared.adjusted],
    rewrittenLinks: [],
    ambiguousLinks: [],
    unresolvedLinks: [],
    lossy: [],
    untouched: [],
    skipped: [...history, ...collected.skipped],
    conflicts: collected.conflicts,
    problems: [],
    generated: [],
  };
}

/** Decodes a note, or reports it as a conflict when it isn't UTF-8 text. */
function noteText(file: CollectedFile, report: Mutable<ImportReport>): string | null {
  const text = fileText(file.data);
  if (text === null) {
    report.conflicts.push({ path: file.raw, reason: "The file isn't UTF-8 text." });
  }
  return text;
}

/**
 * An OKF bundle, taken as it is: notes byte for byte at their paths, everything else as an
 * attachment. Hidden files are skipped; notes with problems are imported and listed.
 */
function importOkf(
  files: readonly PreparedFile[],
  prepared: Prepared,
  detected: Detected,
  history: { path: string; reason: string }[],
): ImportResult {
  const collected = collect(files, (path) =>
    isHidden(path) ? "A hidden file, not part of the bundle." : null,
  );
  const report = newReport(detected, prepared, collected, history);
  const notes: ImportedNote[] = [];
  const attachments: ImportedAttachment[] = [];
  for (const file of collected.files) {
    if (file.kind === "attachment") {
      attachments.push({ path: file.path, data: file.data, source: file.raw });
      continue;
    }
    const text = noteText(file, report);
    if (text === null) continue;
    const problems = parseNote(text).problems;
    if (problems.length > 0) report.problems.push({ path: file.path, problems });
    notes.push({ path: file.path, text, source: file.raw });
  }
  report.notes = notes.length;
  report.attachments = attachments.length;
  return { notes, attachments, folders: sortedFolders(collected.folders), report };
}

const RESERVED_RENAMES: Readonly<Record<string, string>> = {
  "index.md": "index-note.md",
  "log.md": "log-note.md",
};

function obsidianSkip(path: string): string | null {
  if (/^\.obsidian(\/|$)/.test(path)) return "Obsidian's settings and plugins.";
  if (/^\.trash(\/|$)/.test(path)) return "Obsidian's trash.";
  return isHidden(path) ? "A hidden file, not part of the vault." : null;
}

/** Plans each file's final path: reserved note names are renamed, unless the new name is taken. */
function planPaths(
  files: readonly CollectedFile[],
  untouchedFolders: readonly string[],
  report: Mutable<ImportReport>,
): VaultEntry[] {
  const taken = new Set(files.map((file) => file.path.toLowerCase()));
  const entries: VaultEntry[] = [];
  for (const file of files) {
    const rename =
      file.kind === "note" ? RESERVED_RENAMES[fileNameOf(file.path).toLowerCase()] : undefined;
    if (rename === undefined || isInside(file.path, untouchedFolders)) {
      entries.push({ original: file.path, final: file.path, kind: file.kind });
      continue;
    }
    const final = joinPath(folderOf(file.path), rename);
    if (taken.has(final.toLowerCase())) {
      report.conflicts.push({
        path: file.raw,
        reason: `OKF reserves this name, and ${final} already exists: rename one of them and import again.`,
        paths: [file.path, final],
      });
      continue;
    }
    taken.add(final.toLowerCase());
    report.renamed.push({
      from: file.path,
      to: final,
      reason: "OKF reserves index.md and log.md.",
    });
    entries.push({ original: file.path, final, kind: file.kind });
  }
  return entries;
}

/** Wikilinks written in a note's frontmatter, which the import keeps as they are. */
function frontmatterWikilinks(source: string): string[] {
  return [...source.matchAll(/\[\[[^\]\n]*\]\]/g)].map((match) => match[0]);
}

/**
 * An Obsidian vault, converted by the migration rules: reserved note names renamed, wikilinks and
 * embeds turned into relative markdown links, the OKF fields a note lacks added (every existing
 * key kept byte for byte), an `index.md` written in every folder with notes and a root `log.md`
 * recording the import. Settings, plugins and hidden files are skipped; daily notes, templates and
 * canvases are imported as they are. Everything left out, left alone or lossy is reported.
 */
function importObsidian(
  files: readonly PreparedFile[],
  prepared: Prepared,
  detected: Detected,
  history: { path: string; reason: string }[],
  options: ImportOptions,
): ImportResult {
  const collected = collect(files, obsidianSkip);
  const report = newReport(detected, prepared, collected, history);
  const folders = obsidianFolders(files);
  const untouchedFolders = [...folders.daily, ...folders.templates];
  const entries = planPaths(collected.files, untouchedFolders, report);
  const vault = new Vault(entries);
  const byOriginal = new Map(collected.files.map((file) => [file.path, file]));
  const notes: ImportedNote[] = [];
  const attachments: ImportedAttachment[] = [];

  for (const entry of entries) {
    const file = byOriginal.get(entry.original);
    if (file === undefined) continue;
    if (entry.kind === "attachment") {
      if (entry.final.toLowerCase().endsWith(".canvas")) {
        report.untouched.push({ path: entry.final, reason: "An Obsidian canvas, kept as a file." });
      }
      attachments.push({ path: entry.final, data: file.data, source: file.raw });
      continue;
    }
    const text = noteText(file, report);
    if (text === null) continue;
    if (isInside(entry.original, untouchedFolders)) {
      const reason = isInside(entry.original, folders.daily)
        ? "A daily note, imported as it is."
        : "A template, imported as it is.";
      report.untouched.push({ path: entry.final, reason });
      notes.push({ path: entry.final, text, source: file.raw });
      continue;
    }
    const parsed = parseNote(text);
    if (parsed.problems.length > 0) {
      report.problems.push({ path: entry.final, problems: parsed.problems });
      notes.push({ path: entry.final, text, source: file.raw });
      continue;
    }
    for (const link of frontmatterWikilinks(parsed.frontmatter?.source ?? "")) {
      report.lossy.push({
        path: entry.final,
        link,
        reason: "A wikilink in the frontmatter, kept as written.",
      });
    }
    const links = rewriteObsidianLinks(parsed.body, entry, vault);
    report.rewrittenLinks.push(...links.rewritten);
    report.ambiguousLinks.push(...links.ambiguous);
    report.unresolvedLinks.push(...links.unresolved);
    report.lossy.push(...links.lossy);
    const withLinks = links.body === parsed.body ? parsed : setBody(parsed, links.body);
    const converted = addOkfFields(withLinks, {
      // the name the person gave it, even when a reserved name was renamed
      stem: stemOf(entry.original),
      person: options.person,
      at: options.at,
    });
    notes.push({ path: entry.final, text: converted.text, source: file.raw });
  }

  report.notes = notes.length;
  report.attachments = attachments.length;
  const generated = writeIndexes(notes, collected, options.name ?? prepared.root, options);
  report.generated = generated.map((note) => note.path);
  return {
    notes: [...notes, ...generated].sort((a, b) => a.path.localeCompare(b.path)),
    attachments,
    folders: sortedFolders(collected.folders),
    report,
  };
}

/** An `index.md` for every folder with notes that has none, and a root `log.md`. */
function writeIndexes(
  notes: readonly ImportedNote[],
  collected: Collected,
  name: string | null,
  options: ImportOptions,
): ImportedNote[] {
  const existing = new Set(notes.map((note) => note.path.toLowerCase()));
  const byFolder = new Map<string, ImportedNote[]>();
  for (const note of notes) {
    const folder = folderOf(note.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), note]);
  }
  const indexed = sortedFolders(
    foldersWithIndex(
      [...collected.folders],
      notes.map((note) => note.path),
    ),
  );
  const children = new Map<string, string[]>();
  for (const folder of indexed) {
    if (folder === "") continue;
    const parent = folderOf(folder);
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const generated: ImportedNote[] = [];
  for (const folder of indexed) {
    const path = joinPath(folder, "index.md");
    if (existing.has(path.toLowerCase())) continue;
    const heading = folder === "" ? (name ?? "Index") : fileNameOf(folder);
    const text = folderIndex(
      folder,
      byFolder.get(folder) ?? [],
      children.get(folder) ?? [],
      heading,
    );
    generated.push({ path, text, source: "" });
  }
  if (!existing.has("log.md")) {
    const entry = `Imported from Obsidian by ${options.person}: ${String(notes.length)} notes.`;
    generated.push({ path: "log.md", text: logWithEntry(options.at, entry), source: "" });
  }
  return generated;
}

/**
 * Imports an OKF bundle or an Obsidian vault from its files (read from a folder picker or a zip by
 * the caller), without touching a file system: returns the notes and attachments to encrypt and
 * upload, every folder, and a report. With `source: "auto"` (the default) a bundle with a
 * `.obsidian/` folder at its root that isn't already OKF is converted as an Obsidian vault;
 * anything else is taken as OKF, as it is (`report.sourceReason` says which and why). Paths are
 * normalized with core's rules; a path that fails them, or collides with another on a
 * case-insensitive file system, is reported as a conflict and left out, never renamed by
 * guesswork. Throws `ImportLimitError` for a bundle over `maxFiles` or `maxBytes`.
 */
export function importBundle(files: readonly BundleFile[], options: ImportOptions): ImportResult {
  checkLimits(files, options);
  const prepared = prepareFiles(files, options.stripRoot ?? true);
  const { rest, skipped } = historySkip(prepared.files);
  const detected = detectSource(rest, options.source ?? "auto", options.obsidianFolder === true);
  return detected.source === "obsidian"
    ? importObsidian(rest, prepared, detected, skipped, options)
    : importOkf(rest, prepared, detected, skipped);
}
