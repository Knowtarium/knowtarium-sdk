import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { CliEnvironment } from "../env.js";
import type { JsonLayout } from "./json-config.js";

/** Every agent the CLI can add itself to. */
export const AGENT_IDS = ["claude-code", "codex", "cursor", "opencode", "claude-desktop"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** An agent the CLI can add itself to. */
export interface AgentTarget {
  readonly id: AgentId;
  readonly name: string;
  /** The config file the MCP server goes in (a new file is created here). */
  readonly configPath: string;
  /** Other places the agent reads its config from; the first that exists is used instead. */
  readonly otherConfigPaths: readonly string[];
  /** Paths whose existence means the agent is installed (any of them). */
  readonly markers: readonly string[];
  readonly format: JsonLayout | "codex-toml";
}

/**
 * Claude Desktop's config folders: Application Support on macOS, `%APPDATA%\Claude` on Windows
 * (plus the Microsoft Store build's virtualized copy under
 * `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude`), `~/.config/Claude` on Linux.
 */
function claudeDesktopFolders(env: CliEnvironment): string[] {
  if (env.platform === "darwin")
    return [join(env.userHome, "Library", "Application Support", "Claude")];
  if (env.platform !== "win32") return [join(env.userHome, ".config", "Claude")];
  const packages = join(env.localAppData, "Packages");
  let store: string[] = [];
  try {
    store = readdirSync(packages)
      .filter((name) => name.startsWith("Claude_"))
      .map((name) => join(packages, name, "LocalCache", "Roaming", "Claude"));
  } catch {
    // no Store apps folder
  }
  return [join(env.roamingAppData, "Claude"), ...store];
}

/**
 * The agents `connect` configures and where each keeps its MCP servers (user scope, so the server
 * works in every project): Claude Code's `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when
 * that is set), Codex's `~/.codex/config.toml` (`$CODEX_HOME/config.toml`), Cursor's
 * `~/.cursor/mcp.json`, OpenCode's `~/.config/opencode/opencode.json` (or `opencode.jsonc`) and
 * Claude Desktop's `claude_desktop_config.json`.
 */
export function agentTargets(env: CliEnvironment): AgentTarget[] {
  const home = env.userHome;
  const [desktop = "", ...otherDesktops] = claudeDesktopFolders(env);
  const desktopConfig = (folder: string) => join(folder, "claude_desktop_config.json");
  const opencode = join(home, ".config", "opencode");
  const claudeCode = env.claudeConfigDir;
  const codex = env.codexHome ?? join(home, ".codex");
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      configPath: join(claudeCode ?? home, ".claude.json"),
      otherConfigPaths: [],
      markers: [join(claudeCode ?? home, ".claude.json"), claudeCode ?? join(home, ".claude")],
      format: "mcpServers",
    },
    {
      id: "codex",
      name: "Codex",
      configPath: join(codex, "config.toml"),
      otherConfigPaths: [],
      markers: [codex],
      format: "codex-toml",
    },
    {
      id: "cursor",
      name: "Cursor",
      configPath: join(home, ".cursor", "mcp.json"),
      otherConfigPaths: [],
      markers: [join(home, ".cursor")],
      format: "mcpServers",
    },
    {
      id: "opencode",
      name: "OpenCode",
      configPath: join(opencode, "opencode.json"),
      otherConfigPaths: [join(opencode, "opencode.jsonc")],
      markers: [opencode],
      format: "opencode",
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      configPath: desktopConfig(desktop),
      otherConfigPaths: otherDesktops.map(desktopConfig),
      markers: [desktop, ...otherDesktops],
      format: "mcpServers",
    },
  ];
}
