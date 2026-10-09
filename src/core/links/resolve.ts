// Link resolution through lookup keys. Every lookup a link makes goes through a namespaced key
// (`stem:pricing`, `title:pricing model`, `path:research/pricing.md`, `suffix:q3/churn.md`), so a
// workspace can tell exactly which links a note's path or title can affect and re-resolve only
// those.
import { extensionOf, folderOf, resolveRelative, stemOf } from "../path/index.js";
import type { LinkRef, LinkResolution } from "./types.js";

/** What link resolution needs to know about each note. */
export interface LinkTarget {
  readonly id: string;
  /** Normalized workspace path, ending in `.md`. */
  readonly path: string;
  readonly title: string;
}

/** Lookup tables for resolving links in one workspace state. */
export interface LinkIndex {
  /** Note id by exact path. */
  readonly paths: ReadonlyMap<string, string>;
  /** Note ids by lookup key. */
  readonly keys: ReadonlyMap<string, readonly string[]>;
  /** Path by note id. */
  readonly pathOf: ReadonlyMap<string, string>;
}

const ATTACHMENT_EXTENSION = /^\.[a-z0-9]{1,8}$/;

const lower = (value: string): string => value.normalize("NFC").toLowerCase();

/**
 * The keys a note can be found by: its path, every path suffix that starts at a folder boundary
 * (`q3/churn.md` for `research/q3/churn.md`), its file name without `.md`, and its title.
 */
export function targetKeys(target: LinkTarget): string[] {
  const path = lower(target.path);
  const keys = [`path:${path}`, `stem:${lower(stemOf(target.path))}`];
  const segments = path.split("/");
  for (let i = 0; i < segments.length - 1; i++) keys.push(`suffix:${segments.slice(i).join("/")}`);
  const title = lower(target.title.trim());
  if (title !== "") keys.push(`title:${title}`);
  return keys;
}

function withKeys(
  keys: Map<string, readonly string[]>,
  target: LinkTarget,
  change: (ids: readonly string[]) => readonly string[],
): void {
  for (const key of targetKeys(target)) {
    const ids = change(keys.get(key) ?? []);
    if (ids.length === 0) keys.delete(key);
    else keys.set(key, ids);
  }
}

export function createLinkIndex(targets: Iterable<LinkTarget>): LinkIndex {
  const paths = new Map<string, string>();
  const keys = new Map<string, string[]>();
  const pathOf = new Map<string, string>();
  for (const target of targets) {
    paths.set(target.path, target.id);
    pathOf.set(target.id, target.path);
    for (const key of targetKeys(target)) {
      const ids = keys.get(key);
      if (ids === undefined) keys.set(key, [target.id]);
      else ids.push(target.id);
    }
  }
  return { paths, keys, pathOf };
}

/** A new index with one target removed and/or one added; the old index is left as it was. */
export function updateLinkIndex(
  index: LinkIndex,
  removed: LinkTarget | undefined,
  added: LinkTarget | undefined,
): LinkIndex {
  const paths = new Map(index.paths);
  const keys = new Map(index.keys);
  const pathOf = new Map(index.pathOf);
  if (removed !== undefined) {
    if (paths.get(removed.path) === removed.id) paths.delete(removed.path);
    pathOf.delete(removed.id);
    withKeys(keys, removed, (ids) => ids.filter((id) => id !== removed.id));
  }
  if (added !== undefined) {
    paths.set(added.path, added.id);
    pathOf.set(added.id, added.path);
    withKeys(keys, added, (ids) => [...ids, added.id]);
  }
  return { paths, keys, pathOf };
}

/** Picks one of several matches: the one in the linking note's folder, then the shallowest. */
function closest(index: LinkIndex, ids: readonly string[] | undefined, folder: string) {
  if (ids === undefined || ids.length === 0) return undefined;
  if (ids.length === 1) return ids[0];
  const ranked = ids.map((id) => {
    const path = index.pathOf.get(id) ?? "";
    return { id, path, near: folderOf(path) === folder ? 0 : 1, depth: path.split("/").length };
  });
  ranked.sort((a, b) => a.near - b.near || a.depth - b.depth || a.path.localeCompare(b.path));
  return ranked[0]?.id;
}

function withoutMd(target: string): string {
  return target.toLowerCase().endsWith(".md") ? target.slice(0, -3) : target;
}

/** One step of a lookup: a key to try, and an exact path that wins over it when present. */
interface Lookup {
  readonly key: string;
  readonly exact?: string;
}

type Plan =
  | { readonly kind: "lookups"; readonly lookups: readonly Lookup[]; readonly asset: string | null }
  | { readonly kind: "asset"; readonly path: string }
  | { readonly kind: "ghost" };

function wikilinkPlan(target: string, folder: string): Plan {
  const cleaned = target.normalize("NFC").replace(/\\/g, "/").replace(/^\/+/, "");
  const path = `${withoutMd(cleaned)}.md`;
  const lookups: Lookup[] = [];
  if (cleaned.includes("/")) {
    lookups.push({ key: `path:${lower(path)}`, exact: path });
    const relative = resolveRelative(folder, path);
    if (relative !== null) lookups.push({ key: `path:${lower(relative)}`, exact: relative });
    lookups.push({ key: `suffix:${lower(path)}` });
  } else {
    lookups.push({ key: `stem:${lower(withoutMd(cleaned))}` });
  }
  lookups.push({ key: `title:${lower(target.trim())}` });
  const extension = extensionOf(cleaned);
  // an attachment that climbs above the root is a ghost, not an asset
  const asset =
    extension !== ".md" && ATTACHMENT_EXTENSION.test(extension)
      ? resolveRelative(folder, cleaned)
      : null;
  return { kind: "lookups", lookups, asset: asset ?? null };
}

function markdownPlan(target: string, folder: string): Plan {
  const normalized = target.normalize("NFC");
  const rooted = normalized.startsWith("/");
  const candidates = rooted
    ? [resolveRelative("", normalized)]
    : [resolveRelative(folder, normalized), resolveRelative("", normalized)];
  const lookups: Lookup[] = [];
  for (const candidate of candidates) {
    if (candidate === null || candidate === "") continue;
    const extension = extensionOf(candidate);
    if (extension !== "" && extension !== ".md") {
      return lookups.length === 0 ? { kind: "asset", path: candidate } : { kind: "ghost" };
    }
    const path = extension === ".md" ? candidate : `${candidate}.md`;
    lookups.push({ key: `path:${lower(path)}`, exact: path });
  }
  return lookups.length === 0 ? { kind: "ghost" } : { kind: "lookups", lookups, asset: null };
}

function planFor(link: LinkRef, fromPath: string): Plan {
  const folder = folderOf(fromPath);
  return link.kind === "wikilink"
    ? wikilinkPlan(link.target, folder)
    : markdownPlan(link.target, folder);
}

/** The lookup keys a link's resolution depends on (empty for assets and hopeless links). */
export function linkKeys(link: LinkRef, fromPath: string): string[] {
  const plan = planFor(link, fromPath);
  return plan.kind === "lookups" ? plan.lookups.map((lookup) => lookup.key) : [];
}

/**
 * Resolves a link from the note at `fromPath`. Wikilinks match a path (from the root, relative to
 * the note, or a path suffix), else a file name, else a title, case-insensitively, preferring
 * the note's own folder. Markdown links are paths: relative to the note, or to the root when they
 * start with `/` (with a root fallback for relative ones). Links to other file types are assets;
 * links that climb above the root are ghosts.
 */
export function resolveLink(index: LinkIndex, link: LinkRef, fromPath: string): LinkResolution {
  const plan = planFor(link, fromPath);
  if (plan.kind === "asset") return { status: "asset", path: plan.path };
  if (plan.kind === "ghost") return { status: "ghost" };
  const folder = folderOf(fromPath);
  for (const { key, exact } of plan.lookups) {
    const id =
      (exact === undefined ? undefined : index.paths.get(exact)) ??
      closest(index, index.keys.get(key), folder);
    if (id !== undefined) return { status: "note", noteId: id };
  }
  return plan.asset === null ? { status: "ghost" } : { status: "asset", path: plan.asset };
}
