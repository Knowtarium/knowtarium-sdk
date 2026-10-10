import SERVER_COMMAND from "./server-command.json" with { type: "json" };

/** The name of Knowtarium's MCP server in every agent's config. */
export const SERVER_NAME = "knowtarium";

/** The CLI command that runs the MCP server (`knowtarium mcp`). */
export const MCP_COMMAND = "mcp";

/** How an agent starts the MCP server. */
export interface ServerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The command agents run to start the MCP server: this exact CLI version through npx
 * (`npx -y knowtarium@<version> mcp`), so an agent never picks up a different release than the one
 * that wrote its config. On Windows, `npx` is a batch file that agents can't start directly, so
 * it goes through `cmd /c`. The arguments live in `server-command.json`, which the bundle build
 * (`scripts/build-extras.js`) reads too, to write them into the plugins' MCP configs.
 */
export function serverCommand(version: string, platform: NodeJS.Platform): ServerCommand {
  const npx = SERVER_COMMAND.npxArgs.map((arg) => arg.replace("{version}", version));
  return platform === "win32"
    ? {
        command: SERVER_COMMAND.windowsPrefix[0] ?? "cmd",
        args: [...SERVER_COMMAND.windowsPrefix.slice(1), "npx", ...npx],
      }
    : { command: "npx", args: npx };
}

/** The command as one line, for people adding it by hand. */
export function commandLine(server: ServerCommand): string {
  return [server.command, ...server.args].join(" ");
}
