import { ready } from "../crypto/index.js";
import { EncryptedCache, type FetchLike, TrustState } from "../client/index.js";
import { npxFolder } from "./agents/server-entry.js";
import { type CliEnvironment, cliEnvironment } from "./env.js";
import type { CliIo } from "./io.js";
import { Credentials } from "./storage/credentials.js";
import { FileCacheAdapter } from "./storage/file-cache.js";
import { FileTrustStorage } from "./storage/file-trust.js";
import { openSecretStore, type SecretStore } from "./storage/secret-store.js";

/**
 * Everything a command needs. The secret store (the OS keychain) and the credentials it unlocks
 * open only when a command asks for them, so `help`, `validate`, `agents` and `status --offline`
 * never touch the keychain.
 */
export interface CliContext {
  readonly env: CliEnvironment;
  readonly io: CliIo;
  readonly fetch: FetchLike;
  readonly trust: TrustState;
  readonly cache: EncryptedCache;
  readonly version: string;
  secrets(): Promise<SecretStore>;
  credentials(): Promise<Credentials>;
}

/** Memoizes an async factory. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= make());
}

/** A context over an environment and a way to open the secret store. */
export function makeCliContext(details: {
  readonly env: CliEnvironment;
  readonly io: CliIo;
  readonly fetch: FetchLike;
  readonly version: string;
  readonly openSecrets: () => Promise<SecretStore>;
}): CliContext {
  const secrets = once(details.openSecrets);
  const credentials = once(async () => new Credentials(details.env.home, await secrets()));
  return {
    env: details.env,
    io: details.io,
    fetch: details.fetch,
    version: details.version,
    trust: new TrustState(new FileTrustStorage(details.env.home)),
    cache: new EncryptedCache(new FileCacheAdapter(details.env.cache)),
    secrets,
    credentials,
  };
}

/**
 * The real context: the environment (with the folder of the Node.js running this CLI, for agent
 * configs), the keychain (or its fallback) and the files on disk.
 */
export async function createCliContext(io: CliIo, version: string): Promise<CliContext> {
  await ready();
  const base = cliEnvironment();
  const nodeFolder = npxFolder(process.execPath, base.platform);
  const env: CliEnvironment = nodeFolder === undefined ? base : { ...base, nodeFolder };
  return makeCliContext({
    env,
    io,
    fetch: globalThis.fetch,
    version,
    openSecrets: () => openSecretStore(env.home),
  });
}
