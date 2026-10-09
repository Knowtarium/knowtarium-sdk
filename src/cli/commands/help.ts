/** Each command's usage lines, as `knowtarium help` and `knowtarium <command> --help` show them. */
export const USAGE: Readonly<Record<string, string>> = {
  connect: `  knowtarium connect [--no-agents] [--yes] [--dry-run]
      Connect this computer to a workspace (opens the browser), then add
      Knowtarium to the agents found here. \`login\` does the same.`,
  agents: `  knowtarium agents [--yes] [--dry-run] [--agent <id>]...
      Add the MCP server to Claude Code, Claude Desktop, Cursor, Codex or OpenCode
      (ids: claude-code, claude-desktop, cursor, codex, opencode).`,
  status: `  knowtarium status [--offline] [--json]
      Show the connected workspaces, their scope, token and cache.`,
  disconnect: `  knowtarium disconnect [--workspace <id>] [--all]
      Revoke the token and delete the local keys and cache.`,
  convert: `  knowtarium convert <vault> <out> --person <your name> [--dry-run]
      Convert an Obsidian vault into an OKF bundle in a new folder, offline
      (the vault is only read); prints the report and saves it in the output.`,
  validate: `  knowtarium validate <folder> [--strict] [--json]
      Check a local OKF folder, offline.`,
  mcp: `  knowtarium mcp [--actor <producer/version>] [--no-live]
      Run the MCP server on stdio (agents start this themselves).`,
};

const ENVIRONMENT = `Environment:
  KNOWTARIUM_API_URL   the sync API (default https://api.knowtarium.com)
  KNOWTARIUM_APP_URL   the web app (default https://app.knowtarium.com)
                       (both https://, or http:// to localhost and 127.0.0.1 only)
  KNOWTARIUM_HOME      where credentials and trust marks live
  KNOWTARIUM_CACHE     where the encrypted cache lives
  KNOWTARIUM_KEYCHAIN  \`off\` to keep keys in a private file instead of the OS keychain
`;

/** The usage text. */
export const HELP = `knowtarium: connect your AI agents to a Knowtarium workspace.

Usage:
${Object.values(USAGE).join("\n")}

${ENVIRONMENT}`;

/** One command's usage (`knowtarium <command> --help`); `login` is `connect`. */
export function commandHelp(name: string): string | undefined {
  const usage = USAGE[name === "login" ? "connect" : name];
  return usage === undefined ? undefined : `Usage:\n${usage}\n\n${ENVIRONMENT}`;
}
