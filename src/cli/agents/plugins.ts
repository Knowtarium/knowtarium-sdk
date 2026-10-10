import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "smol-toml";

import type { CliEnvironment } from "../env.js";
import { isRecord } from "./json-config.js";
import type { AgentId } from "./targets.js";

/** The Knowtarium plugin, as Claude Code and Codex name it: plugin `knowtarium` of marketplace `knowtarium`. */
export const PLUGIN_ID = "knowtarium@knowtarium";

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Whether Claude Code has the Knowtarium plugin installed for the user (not only for a project)
 * and not turned off: `plugins/installed_plugins.json` in its folder (`~/.claude`, or
 * `$CLAUDE_CONFIG_DIR`) lists it with a `user` scope (version 2 lists installs per scope; version
 * 1, one per plugin), and `enabledPlugins` in its user `settings.json` doesn't say `false`.
 */
async function claudeCodeHasPlugin(env: CliEnvironment): Promise<boolean> {
  const folder = env.claudeConfigDir ?? join(env.userHome, ".claude");
  const installed = await readJson(join(folder, "plugins", "installed_plugins.json"));
  const plugins = isRecord(installed) ? installed["plugins"] : undefined;
  const entry = isRecord(plugins) ? plugins[PLUGIN_ID] : undefined;
  const forUser = Array.isArray(entry)
    ? entry.some((install) => isRecord(install) && install["scope"] === "user")
    : isRecord(entry);
  if (!forUser) return false;
  const settings = await readJson(join(folder, "settings.json"));
  const enabled = isRecord(settings) ? settings["enabledPlugins"] : undefined;
  return !(isRecord(enabled) && enabled[PLUGIN_ID] === false);
}

/**
 * Whether Codex has the Knowtarium plugin installed and not turned off: Codex records it as
 * `[plugins."knowtarium@knowtarium"]` in its `config.toml` (`enabled` missing means on).
 */
async function codexHasPlugin(env: CliEnvironment): Promise<boolean> {
  const folder = env.codexHome ?? join(env.userHome, ".codex");
  let config: unknown;
  try {
    config = parse(await readFile(join(folder, "config.toml"), "utf8"));
  } catch {
    return false;
  }
  const plugins = isRecord(config) ? config["plugins"] : undefined;
  const entry = isRecord(plugins) ? plugins[PLUGIN_ID] : undefined;
  return isRecord(entry) && entry["enabled"] !== false;
}

/**
 * The agents that run Knowtarium's server through the plugin already: adding it to their config
 * too would start a second server (Claude Code), or replace the plugin's (Codex). Best effort: a
 * file that can't be read counts as no plugin.
 */
export async function agentsWithPlugin(env: CliEnvironment): Promise<Set<AgentId>> {
  const found = new Set<AgentId>();
  if (await claudeCodeHasPlugin(env)) found.add("claude-code");
  if (await codexHasPlugin(env)) found.add("codex");
  return found;
}
