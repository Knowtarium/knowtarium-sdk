import { homedir } from "node:os";
import { join } from "node:path";

/** The production sync API. */
export const DEFAULT_API_URL = "https://api.knowtarium.com";
/** The production web app, where `connect` sends the person. */
export const DEFAULT_APP_URL = "https://app.knowtarium.com";

/** Where the CLI talks to and keeps its files, from the environment with production defaults. */
export interface CliEnvironment {
  /** `KNOWTARIUM_API_URL`. */
  readonly apiUrl: string;
  /** `KNOWTARIUM_APP_URL`. */
  readonly appUrl: string;
  /** `KNOWTARIUM_HOME`: settings, the encrypted credentials file and the trust marks. */
  readonly home: string;
  /** `KNOWTARIUM_CACHE`: the encrypted note cache. */
  readonly cache: string;
  /** The user's home directory, where agents keep their configs. */
  readonly userHome: string;
  /** Windows: `%APPDATA%` (roaming) and `%LOCALAPPDATA%`, or their defaults under the home. */
  readonly roamingAppData: string;
  readonly localAppData: string;
  readonly platform: NodeJS.Platform;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Hosts a plain `http://` URL may name: this computer, for development. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * An API or app URL from the environment: `https://`, or `http://` only to localhost or
 * 127.0.0.1 (development). Anything else is refused, so a stray setting can't send the agent's
 * token and the encrypted notes over plain HTTP.
 */
function secureUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} isn't a URL (${value}).`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return trimSlash(value);
  }
  throw new Error(
    `${name} must be an https:// URL (plain http:// only for localhost or 127.0.0.1): ${value}`,
  );
}

interface Folders {
  readonly platform: NodeJS.Platform;
  readonly userHome: string;
  readonly roamingAppData: string;
  readonly localAppData: string;
}

/** The platform's folder for app data (XDG on Linux, Application Support on macOS, AppData on Windows). */
function appDataFolder(env: NodeJS.ProcessEnv, folders: Folders): string {
  if (folders.platform === "darwin")
    return join(folders.userHome, "Library", "Application Support", "Knowtarium");
  if (folders.platform === "win32") return join(folders.roamingAppData, "Knowtarium");
  return join(env["XDG_CONFIG_HOME"] ?? join(folders.userHome, ".config"), "knowtarium");
}

function cacheFolder(env: NodeJS.ProcessEnv, folders: Folders): string {
  if (folders.platform === "darwin")
    return join(folders.userHome, "Library", "Caches", "Knowtarium");
  if (folders.platform === "win32") return join(folders.localAppData, "Knowtarium", "Cache");
  return join(env["XDG_CACHE_HOME"] ?? join(folders.userHome, ".cache"), "knowtarium");
}

/**
 * Reads the environment. Overrides are for development (`http://localhost:8787`) and tests; the
 * URLs must be https, or http to this computer only.
 */
export function cliEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): CliEnvironment {
  const folders: Folders = {
    platform,
    userHome,
    roamingAppData: env["APPDATA"] ?? join(userHome, "AppData", "Roaming"),
    localAppData: env["LOCALAPPDATA"] ?? join(userHome, "AppData", "Local"),
  };
  return {
    apiUrl: secureUrl("KNOWTARIUM_API_URL", env["KNOWTARIUM_API_URL"] ?? DEFAULT_API_URL),
    appUrl: secureUrl("KNOWTARIUM_APP_URL", env["KNOWTARIUM_APP_URL"] ?? DEFAULT_APP_URL),
    home: env["KNOWTARIUM_HOME"] ?? appDataFolder(env, folders),
    cache: env["KNOWTARIUM_CACHE"] ?? cacheFolder(env, folders),
    ...folders,
  };
}
