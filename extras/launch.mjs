// The Claude Code plugin's MCP server launcher: Claude Code runs `node launch.mjs`, which starts
// `npx -y knowtarium@<version> mcp` (through `cmd /c` on Windows, where npx is a batch file) with
// the same stdio. The arguments come from server-command.json next to it, written by the build.
// Signals are passed on, the exit code comes back, and on Windows the whole process tree goes
// when the launcher stops (killing cmd alone would leave node running).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import process from "node:process";
import { URL } from "node:url";

const { args } = JSON.parse(
  readFileSync(new URL("./server-command.json", import.meta.url), "utf8"),
);
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
