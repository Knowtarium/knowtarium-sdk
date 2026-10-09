// The Claude Code plugin's launcher (extras/launch.mjs) against a stand-in `npx`: it passes the
// pinned arguments and stdio, returns the exit code, and passes a stop signal on.
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { temporaryFolder } from "../testing/context.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** A plugin folder whose `npx` is a script that logs its arguments and does what `body` says. */
async function launcher(body: string) {
  const folder = await temporaryFolder();
  cleanup = folder.cleanup;
  const server = join(folder.path, "plugin", "server");
  const bin = join(folder.path, "bin");
  await mkdir(server, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile("extras/launch.mjs", join(server, "launch.mjs"));
  await writeFile(
    join(server, "server-command.json"),
    JSON.stringify({ args: ["-y", "knowtarium@1.2.3", "mcp"] }),
  );
  await writeFile(join(bin, "npx"), `#!/bin/sh\necho "args: $*"\n${body}\n`);
  await chmod(join(bin, "npx"), 0o755);
  const child = spawn(process.execPath, [join(server, "launch.mjs")], {
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  return { child, exit, output: () => output };
}

describe.skipIf(process.platform === "win32")("the plugin launcher", () => {
  it("runs the pinned server command and returns its exit code", async () => {
    const run = await launcher("exit 3");
    expect(await run.exit).toBe(3);
    expect(run.output()).toBe("args: -y knowtarium@1.2.3 mcp\n");
  });

  it("passes a stop signal on to the server", async () => {
    const run = await launcher('trap "exit 42" TERM\nwhile true; do sleep 0.05; done');
    while (!run.output().includes("args:")) await new Promise((resolve) => setTimeout(resolve, 10));
    run.child.kill("SIGTERM");
    expect(await run.exit).toBe(42);
  });
});
