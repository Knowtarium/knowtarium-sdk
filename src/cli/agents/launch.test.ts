// The plugins' launcher (extras/launch.mjs) against a stand-in `npx`: it passes the pinned
// arguments it was given and stdio on, runs npx in the user's home folder (never the project
// folder the client starts it in), refuses arguments cmd could read as commands, returns the exit
// code, and passes a stop signal on. The Windows cases run on Windows (CI): there npx goes through
// cmd.exe, which looks in the current folder first.
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { temporaryFolder } from "../testing/context.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const windows = process.platform === "win32";

/** A stand-in `npx` that prints the folder it runs in and its arguments, then does `body`. */
async function fakeNpx(folder: string, marker: string, body: string) {
  await mkdir(folder, { recursive: true });
  if (windows) {
    await writeFile(
      join(folder, "npx.cmd"),
      // !CD! is expanded after the line is parsed, so a folder name with & in it stays text
      `@echo off\r\nsetlocal EnableDelayedExpansion\r\necho ${marker}cwd: !CD!\r\necho args: %*\r\n${body}\r\n`,
    );
  } else {
    await writeFile(
      join(folder, "npx"),
      `#!/bin/sh\necho "${marker}cwd: $(pwd -P)"\necho "args: $*"\n${body}\n`,
    );
    await chmod(join(folder, "npx"), 0o755);
  }
}

/**
 * A plugin's launcher started with `args` (as the plugin's MCP config gives them) in a project
 * folder that has an `npx` of its own, with the real stand-in on the PATH and a home folder whose
 * name cmd would misread unquoted.
 */
async function launcher(body: string, args = ["-y", "knowtarium@1.2.3", "mcp"]) {
  const folder = await temporaryFolder();
  cleanup = folder.cleanup;
  const root = await realpath(folder.path);
  const home = join(root, "user & home");
  const project = join(root, "project");
  const server = join(root, "plugin", "server");
  await mkdir(home, { recursive: true });
  await mkdir(server, { recursive: true });
  await copyFile("extras/launch.mjs", join(server, "launch.mjs"));
  await fakeNpx(join(root, "bin"), "", body);
  // the project's own npx: never run, even where the current folder is searched first
  await fakeNpx(project, "PLANTED ", windows ? "exit /b 99" : "exit 99");
  // Windows spells it Path; a second PATH key would leave which one wins to chance
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const child = spawn(process.execPath, [join(server, "launch.mjs"), ...args], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      [pathKey]: `${join(root, "bin")}${delimiter}${process.env[pathKey] ?? ""}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  return { child, exit, home, output: () => output.replaceAll("\r", ""), errors: () => errors };
}

describe("the plugin launcher", () => {
  it("runs the pinned server command in the home folder and returns its exit code", async () => {
    const run = await launcher(windows ? "exit /b 3" : "exit 3");
    expect(await run.exit).toBe(3);
    expect(run.output()).toBe(`cwd: ${run.home}\nargs: -y knowtarium@1.2.3 mcp\n`);
  });

  it("refuses to start without the server's arguments", async () => {
    const run = await launcher("exit 0", []);
    expect(await run.exit).toBe(1);
    expect(run.output()).toBe("");
  });

  it("refuses an argument a shell could read as a command", async () => {
    for (const unsafe of ["knowtarium@1.2.3&calc", "a b", "$(id)", '"x"', "%PATH%", ""]) {
      const run = await launcher("exit 0", ["-y", unsafe, "mcp"]);
      expect(await run.exit).toBe(1);
      expect(run.output()).toBe("");
      expect(run.errors()).toContain("refuses the argument");
      await cleanup?.();
      cleanup = undefined;
    }
  });

  it.skipIf(windows)("passes a stop signal on to the server", async () => {
    const run = await launcher('trap "exit 42" TERM\nwhile true; do sleep 0.05; done');
    while (!run.output().includes("args:")) await new Promise((resolve) => setTimeout(resolve, 10));
    run.child.kill("SIGTERM");
    expect(await run.exit).toBe(42);
  });
});
