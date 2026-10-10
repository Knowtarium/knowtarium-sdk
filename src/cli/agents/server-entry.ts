import { win32 } from "node:path";

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

/** What a server command may contain: a version, flags and the `mcp` command, nothing a shell reads. */
const PLAIN_ARGUMENT = /^[\w@.\-/=:]+$/;

/** `npx`'s arguments for this version: `-y knowtarium@<version> mcp`. */
export function npxArgs(version: string): string[] {
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version)) {
    throw new Error(`not a plain server argument: version ${JSON.stringify(version)}`);
  }
  const args = SERVER_COMMAND.npxArgs.map((arg) => arg.replace("{version}", version));
  for (const arg of args) {
    if (!PLAIN_ARGUMENT.test(arg)) throw new Error(`not a plain server argument: ${arg}`);
  }
  return args;
}

/** Windows' own `cmd.exe`, by its full path (never one found in the folder an agent starts in). */
export function windowsShell(env: { readonly comSpec?: string; readonly systemRoot?: string }) {
  const isCmd = (path: string | undefined): path is string =>
    path !== undefined && win32.isAbsolute(path) && /(^|\\)cmd\.exe$/i.test(path);
  if (isCmd(env.comSpec)) return env.comSpec;
  const fromRoot =
    env.systemRoot === undefined ? undefined : win32.join(env.systemRoot, "System32", "cmd.exe");
  return isCmd(fromRoot) ? fromRoot : "C:\\Windows\\System32\\cmd.exe";
}

/**
 * The command agents run to start the MCP server: this exact CLI version through npx
 * (`npx -y knowtarium@<version> mcp`), so an agent never picks up a different release than the one
 * that wrote its config.
 *
 * Agents start their servers in the project folder they have open, and npx trusts that folder: it
 * would run a `node_modules/knowtarium` (or a `node_modules/.bin/knowtarium@<version>`) planted
 * there or in a parent instead of the registry's package, apply the folder's `.npmrc` (whose
 * `node-options` runs code before the CLI), and put its `node_modules/.bin` on the PATH ahead of
 * the real `node`. So the command first goes to the user's home folder, and only then runs npx:
 * `/bin/sh -c 'cd -- "${HOME:?}" && exec npx ...'`, which stops (non-zero) when HOME is unset or
 * empty, where a bare `cd` would stay in the project folder in some shells (dash, busybox). On
 * Windows, `npx` is a batch file agents can't start directly and `cmd` looks in the current folder
 * first, so it is Windows' own `cmd.exe` by its full path, `/d` (no AutoRun), `/v:on` and
 * `!USERPROFILE!`, expanded after the line is parsed, so a profile path with `&` or `)` in it stays
 * one path; without USERPROFILE it exits with 1 instead of a bare `cd /d` that stays put. npx then
 * runs with delayed expansion on, so a `!` in the path of Node or npm makes it fail (closed). `--prefix` isn't used: it stops neither the PATH nor the
 * planted bin, and it moves npm's global config. The arguments live in `server-command.json`,
 * which the bundle build (`scripts/build-extras.js`) reads too, for the plugins' launcher.
 */
export function serverCommand(
  version: string,
  platform: NodeJS.Platform,
  windows: { readonly comSpec?: string; readonly systemRoot?: string } = {},
): ServerCommand {
  const npx = ["npx", ...npxArgs(version)].join(" ");
  return platform === "win32"
    ? {
        command: windowsShell(windows),
        args: [
          "/d",
          "/v:on",
          "/s",
          "/c",
          `if defined USERPROFILE (cd /d !USERPROFILE!&& ${npx}) else exit 1`,
        ],
      }
    : { command: "/bin/sh", args: ["-c", `cd -- "\${HOME:?}" && exec ${npx}`] };
}

/** The command as one line, for people adding it by hand (an argument with spaces is quoted). */
export function commandLine(server: ServerCommand, platform: NodeJS.Platform): string {
  const quote = (arg: string) =>
    PLAIN_ARGUMENT.test(arg)
      ? arg
      : platform === "win32"
        ? `"${arg}"`
        : `'${arg.replaceAll("'", `'\\''`)}'`;
  return [server.command, ...server.args].map(quote).join(" ");
}
