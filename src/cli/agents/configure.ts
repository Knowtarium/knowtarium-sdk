import { Buffer } from "node:buffer";
import { access, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isWindowsBusy, readIfExists, replaceFile, writePrivateFile } from "../storage/files.js";
import { type ConfigEdit, upsertJsonServer } from "./json-config.js";
import type { ServerCommand } from "./server-entry.js";
import type { AgentTarget } from "./targets.js";
import { upsertCodexServer } from "./toml-config.js";

/** How many backups of one config file are kept (the oldest go first). */
const KEPT_BACKUPS = 3;
const BACKUP_INFIX = ".knowtarium-backup-";

/** What configuring one agent did (or, in a dry run, would do). */
export interface AgentResult {
  readonly agent: AgentTarget["id"];
  readonly name: string;
  readonly path: string;
  readonly status: "added" | "updated" | "unchanged" | "skipped";
  /** Where the previous file was copied before the change. */
  readonly backup?: string;
  readonly reason?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The agents whose markers exist on this computer. */
export async function detectAgents(targets: readonly AgentTarget[]): Promise<AgentTarget[]> {
  const found: AgentTarget[] = [];
  for (const target of targets) {
    if ((await Promise.all(target.markers.map(exists))).some(Boolean)) found.push(target);
  }
  return found;
}

/**
 * The file to edit: the agent's main config path, or another it reads when only that one exists
 * (`opencode.jsonc`, the Store build of Claude Desktop). A symlink is followed, so the link
 * stays and its target is what changes.
 */
async function configFile(target: AgentTarget): Promise<string> {
  let path = target.configPath;
  if (!(await exists(path))) {
    for (const other of target.otherConfigPaths) {
      if (await exists(other)) {
        path = other;
        break;
      }
    }
  }
  return realpath(path).catch(() => path);
}

function editOf(target: AgentTarget, text: string | null, server: ServerCommand): ConfigEdit {
  return target.format === "codex-toml"
    ? upsertCodexServer(text, server)
    : upsertJsonServer(text, target.format, server);
}

function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

function same(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return a === null || b === null ? a === b : Buffer.from(a).equals(Buffer.from(b));
}

/**
 * Whether an agent's config already has a Knowtarium entry, and the file it is in. A file that
 * can't be read or edited safely counts as having one: configuring it then says why it can't.
 */
export async function existingEntry(
  target: AgentTarget,
  server: ServerCommand,
): Promise<{ readonly path: string; readonly found: boolean }> {
  const path = await configFile(target);
  try {
    const edit = editOf(target, decode(await readIfExists(path)), server);
    return { path, found: edit.status !== "added" };
  } catch {
    return { path, found: true };
  }
}

/**
 * Keeps the newest backups of a file (their names sort by time). Best effort: a backup that
 * can't be removed (on Windows, one another program has open) stays until a later run.
 */
async function pruneBackups(path: string): Promise<void> {
  const prefix = basename(path) + BACKUP_INFIX;
  const backups = (await readdir(dirname(path))).filter((name) => name.startsWith(prefix)).sort();
  for (const name of backups.slice(0, -KEPT_BACKUPS)) {
    await rm(join(dirname(path), name), { force: true }).catch(() => undefined);
  }
}

/**
 * Adds Knowtarium's MCP server to each agent's config: only Knowtarium's own entry is added or
 * updated, every other server and setting stays; running it again changes nothing; a file that
 * can't be read safely is skipped, never overwritten. The file is read again right before the
 * write and the change applied to what is there then (an agent may have just saved it); the
 * previous file is copied next to it (`<name>.knowtarium-backup-<time>`, the last three kept).
 * A file that can't be read or written (on Windows, one the agent has open) is skipped with the
 * reason, and the other agents are still configured. With `dryRun`, nothing is written.
 */
export async function configureAgents(
  targets: readonly AgentTarget[],
  server: ServerCommand,
  options: { readonly dryRun?: boolean; readonly now?: () => Date } = {},
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  for (const target of targets) {
    const path = await configFile(target);
    const base = { agent: target.id, name: target.name, path };
    try {
      results.push(await configureOne(target, path, server, options));
    } catch (error) {
      // one agent's file failing (on Windows, the agent saving it right then) never stops the rest
      const code = (error as NodeJS.ErrnoException).code;
      const why = isWindowsBusy(error) ? "in use" : (code ?? (error as Error).message);
      results.push({
        ...base,
        status: "skipped",
        reason: `couldn't write ${path} (${why}); run \`npx knowtarium agents\` again from your home folder.`,
      });
    }
  }
  return results;
}

/** Configures one agent whose config file is `path` (see `configureAgents`). */
async function configureOne(
  target: AgentTarget,
  path: string,
  server: ServerCommand,
  options: { readonly dryRun?: boolean; readonly now?: () => Date },
): Promise<AgentResult> {
  const base = { agent: target.id, name: target.name, path };
  const bytes = await readIfExists(path);
  let edit = editOf(target, decode(bytes), server);
  if (edit.status === "added" || edit.status === "updated") {
    if (options.dryRun === true) {
      return { ...base, status: edit.status, reason: "dry run: nothing written" };
    }
    const fresh = await readIfExists(path);
    if (!same(fresh, bytes)) edit = editOf(target, decode(fresh), server);
    if (edit.status === "added" || edit.status === "updated") {
      let backup: string | undefined;
      if (fresh !== null) {
        const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
        backup = `${path}${BACKUP_INFIX}${stamp}`;
        const mode = (await stat(path)).mode & 0o777;
        await writePrivateFile(backup, fresh, mode);
        await pruneBackups(path);
      }
      await replaceFile(path, edit.text);
      return { ...base, status: edit.status, ...(backup === undefined ? {} : { backup }) };
    }
  }
  return edit.status === "invalid"
    ? { ...base, status: "skipped", reason: edit.reason }
    : { ...base, status: "unchanged" };
}
