import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import {
  type BundleFile,
  exportBundle,
  importBundle,
  type ImportResult,
  isActor,
} from "../../core/index.js";
import type { CliContext } from "../context.js";
import {
  assertReady,
  createOutput,
  OutputRefused,
  OutputWriter,
  plannedOutput,
  type RaceHooks,
  vaultFolder,
} from "../convert/output.js";
import { scanVault, VAULT_LIMITS, type WalkSkip } from "../convert/scan.js";
import { copySettings } from "../convert/settings.js";

/** Where the conversion report goes in the output: hidden, so validation and imports skip it. */
export const REPORT_PATH = ".knowtarium/conversion-report.md";

/**
 * The machine-readable record of a conversion: the notes copied unchanged (daily notes,
 * templates), which `knowtarium validate` reports as warnings, not errors, when they lack a
 * `type`, and the notes whose frontmatter was already broken in the vault.
 */
export const RECORD_PATH = ".knowtarium/conversion.json";

/** A path for a report line: in backticks, so odd names stay readable. */
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

/** One part of the report: a title, what it means, and its items. */
interface ReportSection {
  readonly title: string;
  readonly explain: string;
  readonly items: readonly string[];
}

/** The report's parts: the counts and every section, empty ones included. */
function reportParts(
  result: ImportResult,
  notRead: readonly WalkSkip[],
  hardLinked: readonly WalkSkip[],
): { counts: [string, number][]; sections: ReportSection[] } {
  const { report } = result;
  // Obsidian's settings are copied next to the bundle, not skipped
  const settings = report.skipped.filter((entry) => entry.path.startsWith(".obsidian/"));
  const skipped = report.skipped.filter((entry) => !entry.path.startsWith(".obsidian/"));
  const counts: [string, number][] = [
    ["Notes", report.notes],
    ["Attachments", report.attachments],
    ["Files written by the conversion", report.generated.length],
    ["Renamed", report.renamed.length],
    ["Links rewritten", report.rewrittenLinks.length],
    ["Ambiguous links", report.ambiguousLinks.length],
    ["Links to missing notes", report.unresolvedLinks.length],
    ["Lossy (needs a look)", report.lossy.length],
    ["Copied as they are", report.untouched.length],
    ["Obsidian settings copied", settings.length],
    ["Skipped", skipped.length],
    ["Not read", notRead.length],
    ["Hard-linked files", hardLinked.length],
    ["Left out (conflicts)", report.conflicts.length],
    ["Notes with problems", report.problems.length],
  ];
  const sections: ReportSection[] = [
    {
      title: "Left out",
      explain:
        "These couldn't be converted safely and are NOT in the output: fix them in the vault and convert again.",
      items: report.conflicts.map(
        (entry) =>
          `${code(entry.path)}: ${entry.reason}${entry.paths === undefined ? "" : ` (${entry.paths.map(code).join(", ")})`}`,
      ),
    },
    {
      title: "Notes with problems",
      explain: "They were converted, but their frontmatter has problems to fix.",
      items: report.problems.map(
        (entry) =>
          `${code(entry.path)}: ${entry.problems.map((problem) => problem.message).join(" ")}`,
      ),
    },
    {
      title: "Not read",
      explain:
        "Symbolic links (never followed), hidden folders and files, and anything that couldn't be read: none of it is in the output.",
      items: notRead.map((entry) => `${code(entry.path)}: ${entry.reason}`),
    },
    {
      title: "Hard-linked files",
      explain:
        "These vault files have other names on disk (hard links). The copy holds them as ordinary files: editing one in the copy doesn't change the others.",
      items: hardLinked.map((entry) => `${code(entry.path)}: ${entry.reason}`),
    },
    {
      title: "Renamed",
      explain:
        "OKF reserves `index.md` and `log.md` in every folder, and some names can't be paths everywhere; every link to these files was updated.",
      items: report.renamed.map(
        (entry) => `${code(entry.from)} to ${code(entry.to)}: ${entry.reason}`,
      ),
    },
    {
      title: "Ambiguous links",
      explain:
        "Several notes have this name; the link now points to the one Obsidian would open. Check that it is the one meant.",
      items: report.ambiguousLinks.map(
        (entry) =>
          `${code(entry.path)}: ${code(entry.link)} now points to ${code(entry.chosen)} (${String(entry.total)} candidates: ${entry.candidates.map(code).join(", ")})`,
      ),
    },
    {
      title: "Lossy",
      explain: "These can't be expressed exactly in OKF; they were kept as close as possible.",
      items: report.lossy.map(
        (entry) => `${code(entry.path)}: ${code(entry.link)}: ${entry.reason}`,
      ),
    },
    {
      title: "Links to missing notes",
      explain:
        "These links were already broken in the vault (OKF allows them; they show as notes to write).",
      items: report.unresolvedLinks.map((entry) => `${code(entry.path)}: ${code(entry.link)}`),
    },
    {
      title: "Copied as they are",
      explain:
        "Daily notes, templates, canvases and the like are copied unchanged (`knowtarium validate` reports the notes among them as warnings).",
      items: report.untouched.map((entry) => `${code(entry.path)}: ${entry.reason}`),
    },
    {
      title: "Obsidian settings",
      explain:
        "Copied unchanged next to the bundle (the whole `.obsidian/` folder), so Obsidian opens the copy the same way; they aren't OKF notes. These are the settings the conversion read.",
      items: settings.map((entry) => code(entry.path)),
    },
    {
      title: "Skipped",
      explain: "Not part of the bundle: files the format leaves out.",
      items: skipped.map((entry) => `${code(entry.path)}: ${entry.reason}`),
    },
    {
      title: "Written by the conversion",
      explain: "New files: an `index.md` per folder and the root `log.md` entry.",
      items: report.generated.map(code),
    },
  ];
  return { counts, sections };
}

/** The full conversion report, as markdown: what the output holds in `.knowtarium/`. */
export function conversionReport(
  result: ImportResult,
  details: {
    readonly vault: string;
    readonly out: string;
    readonly at: string;
    readonly notRead: readonly WalkSkip[];
    readonly hardLinked: readonly WalkSkip[];
  },
): string {
  const { counts, sections } = reportParts(result, details.notRead, details.hardLinked);
  const lines = [
    "# Conversion report",
    "",
    `Converted ${code(details.vault)} (${result.report.source}: ${result.report.sourceReason}) into ${code(details.out)} on ${details.at}. The vault itself was not changed.`,
    "",
    "| | |",
    "|---|---|",
    ...counts.map(([label, count]) => `| ${label} | ${String(count)} |`),
  ];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    lines.push(
      "",
      `## ${section.title}`,
      "",
      section.explain,
      "",
      ...section.items.map((item) => `- ${item}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** What the terminal shows: the counts and the first few items of each section. */
export function conversionSummary(conversion: Conversion, shown = 5): string {
  const { counts, sections } = reportParts(
    conversion.result,
    conversion.notRead,
    conversion.hardLinked,
  );
  const lines = counts
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${String(count)}`);
  for (const section of sections) {
    if (section.items.length === 0 || section.title === "Written by the conversion") continue;
    lines.push(
      "",
      `${section.title}:`,
      ...section.items.slice(0, shown).map((item) => `  - ${item}`),
    );
    if (section.items.length > shown) {
      lines.push(`  ... and ${String(section.items.length - shown)} more (see the full report)`);
    }
  }
  return lines.join("\n");
}

/** What a conversion produces: the files to write, every folder, and what wasn't read. */
export interface Conversion {
  readonly result: ImportResult;
  readonly files: readonly BundleFile[];
  readonly folders: readonly string[];
  readonly notRead: readonly WalkSkip[];
  readonly hardLinked: readonly WalkSkip[];
}

/**
 * Converts an Obsidian vault (or an OKF folder) into an OKF bundle in memory with core's
 * `importBundle` and `exportBundle`: OKF fields added with `generated` set to `person`, reserved
 * names renamed, wikilinks and embeds made markdown links, an index per folder and a root log,
 * every other byte kept. The vault is read by `scanVault` (no links followed, hidden folders not
 * read). Nothing is written.
 */
export async function convertVault(
  vaultReal: string,
  options: { readonly person: string; readonly at: Date },
): Promise<Conversion> {
  if (!isActor(options.person) || !options.person.startsWith("human:")) {
    throw new Error(`--person needs a name like "maya" (got ${options.person}).`);
  }
  const scanned = await scanVault(vaultReal);
  // an empty .obsidian folder still makes it an Obsidian vault
  const settings = await lstat(join(vaultReal, ".obsidian")).catch(() => null);
  const result = importBundle(scanned.files, {
    source: "auto",
    obsidianFolder: settings?.isDirectory() === true,
    stripRoot: false,
    person: options.person,
    at: options.at,
    name: basename(vaultReal),
    ...VAULT_LIMITS,
  });
  const exported = exportBundle(
    {
      notes: result.notes.map((note) => ({ id: note.path, path: note.path, text: note.text })),
      attachments: result.attachments,
      folders: result.folders,
    },
    { addMissingIndexes: false },
  );
  return {
    result,
    files: exported.files,
    folders: exported.folders,
    notRead: scanned.skipped,
    hardLinked: scanned.hardLinked,
  };
}

/** The record `validate` reads: the notes copied unchanged, and those with broken frontmatter. */
function conversionRecord(result: ImportResult): string {
  const { report } = result;
  return `${JSON.stringify(
    {
      version: 1,
      untouched: report.untouched.map((entry) => entry.path).filter((path) => /\.md$/i.test(path)),
      problems: report.problems.map((entry) => entry.path),
    },
    null,
    2,
  )}\n`;
}

/**
 * Writes the converted bundle into the prepared, empty output folder (checked again right before,
 * and every folder and file through an `OutputWriter`), copies the vault's `.obsidian` settings
 * next to it, then the report and the record.
 */
export async function writeConversion(
  vaultReal: string,
  outReal: string,
  conversion: Conversion,
  details: { readonly vault: string; readonly at: Date; readonly hooks?: RaceHooks },
): Promise<void> {
  await assertReady(vaultReal, outReal);
  const writer = new OutputWriter(vaultReal, outReal, details.hooks);
  for (const folder of conversion.folders) {
    if (folder !== "") await writer.folder(folder);
  }
  for (const file of conversion.files) await writer.file(file.path, file.data);
  const settingsSkipped = await copySettings(vaultReal, writer);
  const report = conversionReport(conversion.result, {
    vault: details.vault,
    out: outReal,
    at: details.at.toISOString(),
    notRead: [...conversion.notRead, ...settingsSkipped].filter(
      (entry, index, all) => all.findIndex((other) => other.path === entry.path) === index,
    ),
    hardLinked: conversion.hardLinked,
  });
  await writer.file(REPORT_PATH, report);
  await writer.file(RECORD_PATH, conversionRecord(conversion.result));
}

/**
 * `knowtarium convert <vault> <out> --person <name> [--dry-run]`: converts an Obsidian vault into
 * an OKF bundle in a new folder (the vault is only read), prints a summary and saves the full
 * report as `.knowtarium/conversion-report.md` in the output. `--dry-run` prints the summary and
 * writes nothing. Refuses an output folder that isn't new or empty, or that is the vault, inside
 * it or holding it, however the paths are spelled.
 */
export async function convertCommand(
  context: CliContext,
  argv: readonly string[],
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { person: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const { io } = context;
  const [vault, out] = positionals;
  if (vault === undefined || out === undefined || values.person === undefined) {
    io.err("Usage: knowtarium convert <vault> <out> --person <your name> [--dry-run]");
    return 2;
  }
  const dryRun = values["dry-run"] === true;
  const person = values.person.startsWith("human:") ? values.person : `human:${values.person}`;
  try {
    const vaultReal = await vaultFolder(vault);
    // the output folder is checked (and, for a real run, created) before anything is read
    const outReal = dryRun
      ? (await plannedOutput(vaultReal, out)).path
      : await createOutput(vaultReal, out);
    const at = new Date();
    const conversion = await convertVault(vaultReal, { person, at });
    io.out(conversionSummary(conversion));
    io.out("");
    if (dryRun) {
      io.out(`Dry run: nothing was written. Run again without --dry-run to write ${outReal}.`);
      return 0;
    }
    await writeConversion(vaultReal, outReal, conversion, { vault, at });
    io.out(
      `Wrote ${String(conversion.files.length)} files to ${outReal}. Full report: ${join(outReal, REPORT_PATH)}. Check it with: npx knowtarium validate "${outReal}"`,
    );
    return 0;
  } catch (error) {
    if (error instanceof OutputRefused) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}
