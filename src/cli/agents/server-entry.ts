import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

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

/** What `serverCommand` needs to know about this computer, all optional. */
export interface ServerCommandOptions {
  /** Windows: `%ComSpec%` and `%SystemRoot%`, to name `cmd.exe` by its full path. */
  readonly comSpec?: string;
  readonly systemRoot?: string;
  /**
   * The folder of the Node.js that wrote the config, with its npx (`npxFolder`), added to the end
   * of the PATH the server starts with, for agents started from the Dock or the Start menu with a
   * PATH that doesn't name it. Left out when `pathFolder` doesn't accept it.
   */
  readonly nodeFolder?: string;
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

/** A folder name's characters a shell, cmd and every agent's config reader take literally. */
const FOLDER_PART = String.raw`[\p{L}\p{M}\p{N}_ .+@-]+`;
const POSIX_FOLDER = new RegExp(String.raw`^(?:/${FOLDER_PART})+$`, "u");
const WINDOWS_FOLDER = new RegExp(String.raw`^[A-Za-z]:(?:\\${FOLDER_PART})+$`, "u");

/**
 * `folder` when the server command may add it to the PATH, else undefined: an absolute,
 * normalized path of letters, digits, spaces and `_ . + @ -` only, so it needs no quoting beyond
 * the command's own double quotes (sh) or none at all (cmd, where `&`, `)`, `%`, `!`, `^` and `;`
 * would mean something), and no agent rewrites it: no `$`, `{`, `~` or `:` past a drive letter,
 * and no word that Cursor would read as relative to the project (one that is `.` or starts with
 * `./` or `.\`, as Cursor splits its arguments at spaces). A folder inside a `node_modules` (a
 * project's own Node) never counts.
 */
export function pathFolder(folder: string, platform: NodeJS.Platform): string | undefined {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  if (!(windows ? WINDOWS_FOLDER : POSIX_FOLDER).test(folder)) return undefined;
  if (path.normalize(folder) !== folder || folder.endsWith(path.sep)) return undefined;
  if (folder.split(/[\\/]/).some((part) => part.toLowerCase() === "node_modules")) return undefined;
  if (/(?:^|\s)\.(?:$|\s|[\\/])/.test(folder)) return undefined;
  return folder;
}

/**
 * The folder of the Node.js at `execPath` (this CLI's own, `process.execPath`) when it holds npx
 * (`npx`, or `npx.cmd` on Windows) and `pathFolder` accepts it, else undefined.
 */
export function npxFolder(
  execPath: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  if (!/^node(?:\.exe)?$/i.test(path.basename(execPath))) return undefined;
  const folder = pathFolder(path.dirname(execPath), platform);
  return folder !== undefined && exists(path.join(folder, windows ? "npx.cmd" : "npx"))
    ? folder
    : undefined;
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
 * `/bin/sh -c '[ -n "$HOME" ] && cd -- "$HOME" && exec npx ...'`, which stops (with 1) when HOME
 * is unset or empty, where a bare `cd` would stay in the project folder in some shells (dash,
 * busybox) and `cd ""` stays put in bash. It is written without braces: agents expand `${NAME}` in
 * their configs (Cursor, Claude Code, VS Code), and none of them reads a bare `$HOME`. On
 * Windows, `npx` is a batch file agents can't start directly and `cmd` looks in the current folder
 * first, so it is Windows' own `cmd.exe` by its full path, `/d` (no AutoRun), `/v:on` and
 * `!USERPROFILE!`, expanded after the line is parsed, so a profile path with `&` or `)` in it stays
 * one path; without USERPROFILE it exits with 1 instead of a bare `cd /d` that stays put. npx then
 * runs with delayed expansion on, so a `!` in the path of Node or npm makes it fail (closed).
 * `--prefix` isn't used: it stops neither the PATH nor the planted bin, and it moves npm's global
 * config. The arguments live in `server-command.json`, which the bundle build
 * (`scripts/build-extras.js`) reads too, for the plugins' launcher.
 *
 * With `nodeFolder`, the command adds that folder to the end of the PATH before npx
 * (`export PATH="$PATH:<folder>"`, or `set PATH=!PATH!;<folder>` in cmd), so an agent started with
 * a PATH that doesn't name the user's Node (macOS gives apps started from the Dock
 * `/usr/bin:/bin:/usr/sbin:/sbin`) still finds npx, and npx's `#!/usr/bin/env node` finds node.
 * At the end, the agent's own PATH still comes first, and once that Node is removed (`nvm
 * uninstall`) the lookup simply goes on without it.
 */
export function serverCommand(
  version: string,
  platform: NodeJS.Platform,
  options: ServerCommandOptions = {},
): ServerCommand {
  const npx = ["npx", ...npxArgs(version)].join(" ");
  const folder =
    options.nodeFolder === undefined ? undefined : pathFolder(options.nodeFolder, platform);
  if (platform === "win32") {
    const path = folder === undefined ? "" : `set PATH=!PATH!;${folder}&& `;
    return {
      command: windowsShell(options),
      args: [
        "/d",
        "/v:on",
        "/s",
        "/c",
        `if defined USERPROFILE (cd /d !USERPROFILE!&& ${path}${npx}) else exit 1`,
      ],
    };
  }
  const path = folder === undefined ? "" : `export PATH="$PATH:${folder}" && `;
  return {
    command: "/bin/sh",
    args: ["-c", `[ -n "$HOME" ] && cd -- "$HOME" && ${path}exec ${npx}`],
  };
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
