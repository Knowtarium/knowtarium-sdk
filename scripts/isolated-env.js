// A throwaway environment for the tools the build scripts run (npm, mcpb, claude, the knowtarium
// binary): HOME and every config folder point into a temporary folder, the keychain is off, and
// npm uses its own cache and no user config, so nothing reads or writes the real ones.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** A fresh sandbox: its folder, the environment to run tools in, and `cleanup`. */
export function isolatedEnvironment(prefix) {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  const home = join(sandbox, "home");
  const env = {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "roaming"),
    LOCALAPPDATA: join(home, "local"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    KNOWTARIUM_HOME: join(sandbox, "knowtarium"),
    KNOWTARIUM_CACHE: join(sandbox, "knowtarium-cache"),
    KNOWTARIUM_KEYCHAIN: "off",
    npm_config_cache: join(sandbox, "npm-cache"),
    npm_config_userconfig: join(sandbox, "npmrc"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  return {
    sandbox,
    env,
    cleanup: () => {
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}
