import type { WorkspaceKeyring } from "../../crypto/index.js";
import { routes, WrappedWorkspaceKey } from "../../protocol/index.js";
import {
  type ApiClient,
  type CacheAdapter,
  isSyncApiError,
  type KeyProvider,
  type KeyringOptions,
  NetworkError,
  openWorkspaceKeyring,
} from "../../client/index.js";
import { z } from "zod";

const Stored = z.array(WrappedWorkspaceKey);

/** Where a workspace's wrapped keys are kept in the cache (removed with the workspace's cache). */
export function wrappedKeysEntry(workspaceId: string): string {
  return `ws/${workspaceId}/wrapped-keys`;
}

/** Whether an error means the API couldn't be reached (as opposed to a refusal). */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (isSyncApiError(error) && (error.status >= 500 || error.code === "rate_limited"))
  );
}

/**
 * A `KeyProvider` that keeps the signed wrapped key records it fetches in the cache, so a warm
 * cache opens offline. The records are sealed for the CLI's own key and signed by the owner, so
 * the copy on disk is useless without the CLI's private key, and it is verified again (owner
 * signatures, rollback marks) every time it is opened. The first `get` opens the cached records
 * at once, so a warm start never waits for the network, and fetches them again in the background
 * (the newer keyring replaces the cached one when it arrives; a newer generation also comes with
 * the pull, which refreshes). `refresh` asks the API first; only an unreachable API falls back to
 * the cache, and a refusal (a revoked token, say) is passed on.
 */
export function cachedKeyProvider(
  api: ApiClient,
  options: KeyringOptions,
  adapter: CacheAdapter,
): KeyProvider {
  let current: Promise<WorkspaceKeyring> | undefined;
  let inflight: Promise<WorkspaceKeyring> | undefined;
  const entry = wrappedKeysEntry(options.workspaceId);
  const fromCache = async (): Promise<WorkspaceKeyring | null> => {
    const bytes = await adapter.get(entry);
    if (bytes === undefined) return null;
    const parsed = Stored.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? openWorkspaceKeyring(parsed.data, options) : null;
  };
  const fetchAndOpen = async (): Promise<WorkspaceKeyring> => {
    let records: WrappedWorkspaceKey[];
    try {
      ({
        data: { workspaceKeys: records },
      } = await api.call(routes.listKeys));
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      const cached = await fromCache();
      if (cached === null) throw error;
      return cached;
    }
    const keyring = await openWorkspaceKeyring(records, options);
    const mine = records.filter((record) => record.workspaceId === options.workspaceId);
    await adapter.put(entry, new TextEncoder().encode(JSON.stringify(mine)));
    return keyring;
  };
  const refresh = (): Promise<WorkspaceKeyring> => {
    if (inflight !== undefined) return inflight;
    const next = fetchAndOpen().finally(() => {
      inflight = undefined;
    });
    inflight = next;
    current = next;
    next.catch(() => {
      if (current === next) current = undefined;
    });
    return next;
  };
  const first = async (): Promise<WorkspaceKeyring> => {
    const cached = await fromCache().catch(() => null);
    if (cached === null) return refresh();
    // fresh records in the background; until then the verified cached ones serve
    void fetchAndOpen().then(
      (keyring) => {
        if (inflight === undefined) current = Promise.resolve(keyring);
      },
      () => undefined,
    );
    return cached;
  };
  const get = () => (current ??= first());
  // an agent sees only its own copies: the owner's devices hold back writes during a rotation
  return { get, refresh, forWriting: get };
}
