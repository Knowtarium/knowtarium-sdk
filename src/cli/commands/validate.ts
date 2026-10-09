import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  type BundleFile,
  createWorkspace,
  ghostLinks,
  importBundle,
  folderOf,
  isReservedFile,
  resolveRelative,
} from "../../core/index.js";
import type { CliContext } from "../context.js";
import { listFiles } from "../storage/files.js";
import { RECORD_PATH } from "./convert.js";

/** One finding: an error fails validation, a warning only with `--strict`. */
export interface Finding {
  readonly level: "error" | "warning";
  readonly path: string;
  readonly message: string;
  readonly line?: number;
}

/** The files of a folder, hidden folders (`.git`, `.obsidian`) left out. */
async function readFolder(root: string): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  for (const path of await listFiles(root)) {
    if (path.split("/").some((part) => part.startsWith("."))) continue;
    files.push({ path, data: new Uint8Array(await readFile(join(root, path))) });
  }
  return files;
}

/**
 * Checks a local OKF folder with core, offline: every path is valid and unique, every note's
 * frontmatter reads and its OKF fields are valid, every note but `index.md` and `log.md` has a
 * `type` (OKF's one required field), and the root has an `index.md`. Links to notes that don't
 * exist are warnings (OKF allows them; `--strict` fails on them).
 */
export async function validateFolder(root: string): Promise<Finding[]> {
  const files = await readFolder(root);
  // notes `knowtarium convert` copied unchanged (daily notes, templates): no `type` is a warning
  const untouched = new Set<string>();
  try {
    const record = JSON.parse(await readFile(join(root, RECORD_PATH), "utf8")) as {
      untouched?: unknown;
    };
    if (Array.isArray(record.untouched)) {
      // advisory: only Markdown notes listed by the conversion, and only "no type" is softened
      for (const path of record.untouched) {
        if (typeof path === "string" && /\.md$/i.test(path)) untouched.add(path);
      }
    }
  } catch {
    // not a converted vault
  }
  const result = importBundle(files, {
    source: "okf",
    stripRoot: false,
    person: "human:validator",
    at: new Date(),
    maxFiles: 200_000,
    maxBytes: 4 * 1024 * 1024 * 1024,
  });
  const findings: Finding[] = [];
  for (const conflict of result.report.conflicts) {
    findings.push({ level: "error", path: conflict.path, message: conflict.reason });
  }
  const workspace = createWorkspace(
    result.notes.map((note) => ({ id: note.path, path: note.path, text: note.text })),
  );
  for (const note of workspace.notes.values()) {
    for (const problem of note.problems) {
      findings.push({
        level: "error",
        path: note.path,
        message: problem.message,
        ...(problem.line === undefined ? {} : { line: problem.line }),
      });
    }
    if (
      !isReservedFile(note.path) &&
      note.parsed.problems.length === 0 &&
      !("type" in note.frontmatter)
    ) {
      findings.push(
        untouched.has(note.path)
          ? {
              level: "warning",
              path: note.path,
              message:
                "Copied unchanged by the conversion (a daily note or a template), so it has no `type`; add one if it should be a note.",
            }
          : {
              level: "error",
              path: note.path,
              message: "The note has no `type` (OKF's one required field).",
            },
      );
    }
  }
  for (const issue of workspace.issues) {
    findings.push({ level: "error", path: issue.path, message: issue.message });
  }
  if (!workspace.paths.has("index.md")) {
    findings.push({
      level: "warning",
      path: "index.md",
      message: "The folder has no root index.md.",
    });
  }
  for (const link of ghostLinks(workspace)) {
    // an index may link a folder (`[Policies](policies/)`); a folder that exists isn't a ghost
    const from = workspace.notes.get(link.from)?.path ?? "";
    const folder = link.target.endsWith("/") ? resolveRelative(folderOf(from), link.target) : null;
    if (folder !== null && workspace.folders.has(folder)) continue;
    findings.push({
      level: "warning",
      path: link.from,
      line: link.line,
      message: `${link.raw} links to a note that doesn't exist.`,
    });
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}

/** `knowtarium validate <folder> [--strict] [--json]` */
export async function validateCommand(
  context: CliContext,
  argv: readonly string[],
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { strict: { type: "boolean" }, json: { type: "boolean" } },
  });
  const { io } = context;
  const [folder] = positionals;
  if (folder === undefined) {
    io.err("Usage: knowtarium validate <folder> [--strict] [--json]");
    return 2;
  }
  const found = await stat(folder).catch(() => null);
  if (found?.isDirectory() !== true) {
    io.err(
      found === null
        ? `There is no folder ${folder}. Pass the folder that holds the OKF notes (its root index.md).`
        : `${folder} is a file; pass the folder that holds the OKF notes.`,
    );
    return 2;
  }
  const findings = await validateFolder(folder);
  const failing = findings.filter((finding) => finding.level === "error" || values.strict === true);
  if (values.json === true) {
    io.out(JSON.stringify({ ok: failing.length === 0, findings }, null, 2));
  } else {
    for (const finding of findings) {
      const where =
        finding.line === undefined ? finding.path : `${finding.path}:${String(finding.line)}`;
      io.out(`${finding.level === "error" ? "error  " : "warning"} ${where}  ${finding.message}`);
    }
    const errors = findings.filter((finding) => finding.level === "error").length;
    io.out(`${String(errors)} errors, ${String(findings.length - errors)} warnings.`);
  }
  return failing.length === 0 ? 0 : 1;
}
