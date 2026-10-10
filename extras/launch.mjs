// The plugins' MCP server launcher: the client runs `node launch.mjs -y knowtarium@<version> mcp`
// (the arguments, with the exact version, are in the plugin's .mcp.json or mcp.json, written by
// the build), and the launcher starts `npx` with them (through `cmd /c` on Windows, where npx is a
// batch file) and the same stdio. Signals are passed on, the exit code comes back, and on Windows
// the whole process tree goes when the launcher stops (killing cmd alone would leave node running).
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import process from "node:process";

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write(
    "knowtarium: launch.mjs needs the npx arguments, such as -y knowtarium@1.2.3 mcp\n",
  );
  process.exit(1);
}
const windows = process.platform === "win32";
const child = windows
  ? spawn("cmd", ["/c", "npx", ...args], { stdio: "inherit", windowsHide: true })
  : spawn("npx", args, { stdio: "inherit" });

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (windows) {
    if (child.pid !== undefined) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
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
