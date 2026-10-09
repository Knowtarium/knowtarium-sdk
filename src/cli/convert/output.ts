import { lstat, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Why an output folder can't be used, with a message for the person. */
export class OutputRefused extends Error {
  override readonly name = "OutputRefused";
}

const OVERLAP =
  "The output must be a separate folder, not the vault, inside it, or holding it: the vault is never changed.";

/** A path's identity on disk: device and inode, the same whatever spelling reaches it. */
async function identity(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return `${String(info.dev)}:${String(info.ino)}`;
  } catch {
    return null;
  }
}

/** The identities of a folder and every folder above it, up to the root. */
async function chain(path: string): Promise<string[]> {
  const ids: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    const id = await identity(current);
    if (id !== null) ids.push(id);
    if (dirname(current) === current) return ids;
  }
}

/** Whether the volume holding `path` ignores letter case (macOS and Windows by default). */
async function caseInsensitive(path: string): Promise<boolean> {
  const name = basename(path);
  const swapped = Array.from(name)
    .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    .join("");
  if (swapped === name) return true; // nothing to tell by: compare as if it did
  const [original, other] = await Promise.all([
    identity(path),
    identity(join(dirname(path), swapped)),
  ]);
  return original !== null && original === other;
}

/** Whether `inner` is `outer` or inside it, by path (case folded when asked). */
function within(inner: string, outer: string, fold: boolean): boolean {
  const norm = (path: string) => (fold ? path.normalize("NFC").toLowerCase() : path);
  const a = norm(inner);
  const b = norm(outer);
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

/**
 * Refuses an output folder that is the vault, inside it, or holds it: by identity (device and
 * inode up both folders' chains, so case aliases, symlinked parents and `/tmp` against
 * `/private/tmp` can't hide an overlap) and by real path (case folded on a case-insensitive
 * volume).
 */
async function checkApart(vaultReal: string, outReal: string): Promise<void> {
  const vaultId = await identity(vaultReal);
  const outId = await identity(outReal);
  if (vaultId !== null && (await chain(outReal)).includes(vaultId))
    throw new OutputRefused(OVERLAP);
  if (outId !== null && (await chain(vaultReal)).includes(outId)) throw new OutputRefused(OVERLAP);
  const fold = (await caseInsensitive(vaultReal)) || (await caseInsensitive(dirname(outReal)));
  if (within(outReal, vaultReal, fold) || within(vaultReal, outReal, fold)) {
    throw new OutputRefused(OVERLAP);
  }
}

/** The vault's real path; refused when it isn't a folder. */
export async function vaultFolder(vault: string): Promise<string> {
  const real = await realpath(vault).catch(() => null);
  if (real === null || !(await stat(real)).isDirectory()) {
    throw new OutputRefused(`There is no folder ${vault}.`);
  }
  return real;
}

/** Where the output goes: the real path of its nearest existing folder, plus the names to create. */
export interface OutputPlan {
  readonly base: string;
  readonly missing: readonly string[];
  /** `base` joined with `missing`: the output's real path once created. */
  readonly path: string;
}

/**
 * Where the output would go, without creating anything: the nearest existing folder above it,
 * resolved to its real path, plus the missing names. Checked against the vault. Refused when the
 * output is a symbolic link (dangling or not), or exists and isn't an empty folder.
 */
export async function plannedOutput(vaultReal: string, out: string): Promise<OutputPlan> {
  const missing: string[] = [];
  let existing = resolve(out);
  for (;;) {
    const info = await lstat(existing).catch(() => null);
    if (info !== null) {
      if (missing.length === 0 && info.isSymbolicLink()) {
        throw new OutputRefused(`${out} is a symbolic link; give a real folder.`);
      }
      break;
    }
    if (dirname(existing) === existing) break;
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  const base = await realpath(existing).catch(() => null);
  if (base === null) throw new OutputRefused(`${out} can't be reached (a broken link on the way).`);
  const path = join(base, ...missing);
  if (missing.length === 0) {
    if (!(await stat(path)).isDirectory()) throw new OutputRefused(`${out} isn't a folder.`);
    if ((await readdir(path)).length > 0) {
      throw new OutputRefused(`${out} isn't empty; pick a new or empty folder.`);
    }
  }
  await checkApart(vaultReal, path);
  return { base, missing, path };
}

/** Steps tests can run between the checks and the actions, to reproduce races. */
export interface RaceHooks {
  /** After planning, before the first folder is created. */
  readonly afterPlan?: () => Promise<void>;
  /** Before each file is written (its path in the output). */
  readonly beforeWrite?: (path: string) => Promise<void>;
}

/** Refuses unless `path` is a real folder (not a link) whose real path is itself. */
async function assertRealFolder(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) {
    throw new OutputRefused(`${path} was replaced by something else than a folder meanwhile.`);
  }
  if ((await realpath(path)) !== path) {
    throw new OutputRefused(`${path} doesn't lead where it did: something on the way changed.`);
  }
}

/**
 * Creates the output folder: each missing folder with a non-recursive `mkdir` under the planned
 * real path, where a folder that appeared meanwhile is a refusal (never followed), each one
 * checked to be a real folder. Then everything is checked again. Returns the output's real path.
 */
export async function createOutput(
  vaultReal: string,
  out: string,
  hooks: RaceHooks = {},
): Promise<string> {
  const plan = await plannedOutput(vaultReal, out);
  await hooks.afterPlan?.();
  await assertRealFolder(plan.base);
  let current = plan.base;
  for (const name of plan.missing) {
    const next = join(current, name);
    try {
      await mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new OutputRefused(`${next} appeared while the output was being created; try again.`);
      }
      throw error;
    }
    await assertRealFolder(next);
    current = next;
  }
  await assertReady(vaultReal, plan.path);
  return plan.path;
}

/**
 * Right before writing: the output is still a real, empty folder at its own real path, and still
 * apart from the vault by identity and by path.
 */
export async function assertReady(vaultReal: string, outReal: string): Promise<void> {
  await assertRealFolder(outReal);
  if ((await readdir(outReal)).length > 0) {
    throw new OutputRefused("The output folder isn't empty any more; pick a new folder.");
  }
  await checkApart(vaultReal, outReal);
}

/**
 * Writes into the output folder only: folders created one level at a time (each checked to be a
 * real folder at its own real path, so a swapped parent can't redirect anything), files created
 * exclusively (`wx`: never overwriting, never through a link), the output checked against the
 * vault again before each folder is created.
 */
export class OutputWriter {
  private readonly created = new Set<string>();

  constructor(
    private readonly vaultReal: string,
    readonly outReal: string,
    private readonly hooks: RaceHooks = {},
  ) {}

  /** Makes a folder under the output (a `/`-separated relative path), level by level. */
  async folder(relative: string): Promise<string> {
    let current = this.outReal;
    await assertRealFolder(current);
    for (const name of relative.split("/").filter((part) => part !== "")) {
      const next = join(current, name);
      if (!this.created.has(next)) {
        await checkApart(this.vaultReal, current);
        try {
          await mkdir(next);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new OutputRefused(
              `${next} appeared in the output meanwhile; nothing was overwritten.`,
            );
          }
          throw error;
        }
        this.created.add(next);
      }
      await assertRealFolder(next);
      current = next;
    }
    return current;
  }

  /** Writes a new file (a `/`-separated relative path); refused if anything is already there. */
  async file(relative: string, data: Uint8Array | string): Promise<void> {
    await this.hooks.beforeWrite?.(relative);
    const parts = relative.split("/");
    const name = parts.pop() ?? "";
    const folder = await this.folder(parts.join("/"));
    await assertRealFolder(folder);
    await writeFile(join(folder, name), data, { flag: "wx" });
  }
}
