// The plugins' MCP server launcher: the client runs `node launch.mjs -y knowtarium@<version> mcp`
// (the arguments, with the exact version, are in the plugin's .mcp.json or mcp.json, written by
// the build), and the launcher starts `npx` with them and the same stdio. Signals are passed on,
// the exit code comes back, and on Windows the whole process tree goes when the launcher stops
// (killing cmd alone would leave node running).
//
// The client starts it in the project folder it has open, and npx trusts that folder: it would
// run a `node_modules/knowtarium` planted there (or in a parent) instead of the registry's package,
// apply the folder's `.npmrc` (whose `node-options` runs code first), and put the folder's
// `node_modules/.bin` on the PATH ahead of the real `node`. So npx runs in the user's home folder
// instead, never the project's. On Windows, where npx is a batch file, it goes through Windows'
// own cmd.exe by its full path (`/d`: no AutoRun), which then looks for npx in the home folder and
// on the PATH, and the arguments must be plain (a version, flags, `mcp`), so cmd can't read any of
// them as a command.
import { spawn, spawnSync } from "node:child_process";
import { constants, homedir } from "node:os";
import { win32 } from "node:path";
import process from "node:process";

const fail = (message) => {
  process.stderr.write(`knowtarium: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
if (args.length === 0) fail("launch.mjs needs the npx arguments, such as -y knowtarium@1.2.3 mcp");
const unsafe = args.find((arg) => !/^[\w@.\-/=:]+$/.test(arg));
if (unsafe !== undefined) fail(`launch.mjs refuses the argument ${JSON.stringify(unsafe)}`);

/** Windows' own cmd.exe: %ComSpec% when it names one by its full path, else the system's. */
function windowsShell() {
  const isCmd = (path) =>
    typeof path === "string" && win32.isAbsolute(path) && /(^|\\)cmd\.exe$/i.test(path);
  if (isCmd(process.env.ComSpec)) return process.env.ComSpec;
  const fromRoot =
    process.env.SystemRoot === undefined
      ? undefined
      : win32.join(process.env.SystemRoot, "System32", "cmd.exe");
  return isCmd(fromRoot) ? fromRoot : "C:\\Windows\\System32\\cmd.exe";
}

const windows = process.platform === "win32";
const options = { cwd: homedir(), stdio: "inherit" };
const child = windows
  ? spawn(windowsShell(), ["/d", "/s", "/c", "npx", ...args], { ...options, windowsHide: true })
  : spawn("npx", args, options);

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (windows) {
    if (child.pid !== undefined) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        cwd: homedir(),
        stdio: "ignore",
      });
    }
  } else {
    child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stop(signal);
  });
}
process.on("exit", () => {
  if (child.exitCode === null && child.signalCode === null) stop("SIGTERM");
});

child.on("error", (error) => {
  process.stderr.write(
    `knowtarium: couldn't start npx (${error.message}). Install Node.js 20 or later.\n`,
  );
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)));
});
