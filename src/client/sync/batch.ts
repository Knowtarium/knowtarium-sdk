import { fromBase64Url } from "../../crypto/index.js";
import {
  type NoteId,
  routes,
  VERSIONS_BATCH_MAX,
  VERSIONS_BATCH_MAX_BYTES,
} from "../../protocol/index.js";
import { isSyncApiError } from "../errors/index.js";
import type { SyncContext } from "./context.js";

/** How many `getVersions` requests a pull keeps in flight at once. */
export const VERSIONS_BATCH_CONCURRENCY = 4;

/** The key of a prefetched version. */
export function versionKey(noteId: string, version: number): string {
  return `${noteId}@${String(version)}`;
}

/** How long a client reads one by one after its server answered that it has no `getVersions`. */
export const VERSIONS_BATCH_RETRY_MS = 15 * 60 * 1000;

/**
 * Clients (one per session or engine) whose server answered 404 or 405 to `getVersions`, with
 * when: they read one by one for a while, then try batches again (the server may have been
 * updated meanwhile).
 */
const unsupported = new WeakMap<object, number>();

function batchingOff(api: object, now: number): boolean {
  const since = unsupported.get(api);
  if (since === undefined) return false;
  if (now - since < VERSIONS_BATCH_RETRY_MS) return true;
  unsupported.delete(api);
  return false;
}

/** Runs `run` on every item with at most `limit` running at once. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Fetches many note versions' envelopes in batches (`getVersions`, at most 100 per request, a few
 * requests at once) and returns them by `versionKey`. Only versions that were asked for are kept;
 * what the server leaves out is simply missing, so the caller reads it one by one as before.
 * Nothing is verified here: every envelope goes through the same checks as a single read. A
 * server without the route (404 or 405) makes this client (its session or engine) read one by one
 * for `VERSIONS_BATCH_RETRY_MS`, then try batches again.
 */
export async function prefetchVersions(
  context: Pick<SyncContext, "api" | "workspaceId">,
  wanted: readonly { readonly noteId: NoteId; readonly version: number }[],
): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  if (wanted.length === 0 || batchingOff(context.api, Date.now())) return found;
  const batches: (typeof wanted)[] = [];
  for (let i = 0; i < wanted.length; i += VERSIONS_BATCH_MAX) {
    batches.push(wanted.slice(i, i + VERSIONS_BATCH_MAX));
  }
  await eachLimited(batches, VERSIONS_BATCH_CONCURRENCY, async (batch) => {
    if (batchingOff(context.api, Date.now())) return;
    let data;
    try {
      ({ data } = await context.api.call(routes.getVersions, {
        params: { workspaceId: context.workspaceId },
        body: { versions: batch.map(({ noteId, version }) => ({ noteId, version })) },
        idempotent: true,
      }));
    } catch (error) {
      if (isSyncApiError(error) && (error.status === 404 || error.status === 405)) {
        unsupported.set(context.api, Date.now());
        return;
      }
      throw error;
    }
    const asked = new Set(batch.map(({ noteId, version }) => versionKey(noteId, version)));
    // the answer's byte cap holds here too: past it, the rest is read one by one
    let bytes = 0;
    for (const entry of data.versions) {
      const key = versionKey(entry.noteId, entry.version);
      if (!asked.has(key) || found.has(key)) continue;
      // counted from the text before decoding, so an oversized answer is never decoded whole
      bytes += Math.floor((entry.ciphertext.length * 3) / 4);
      if (bytes > VERSIONS_BATCH_MAX_BYTES) break;
      found.set(key, fromBase64Url(entry.ciphertext));
    }
  });
  return found;
}
