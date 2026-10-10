// An agent starts Knowtarium's MCP server in the project folder it has open, so that folder may be
// hostile. These tests plant everything npx would trust there (a `node_modules/knowtarium` of the
// pinned version in the folder and in its parent, a `node_modules/.bin/knowtarium@<version>`, a
// `node_modules/.bin/node`, and an `.npmrc` whose `node-options` requires a script) and run the
// exact command the CLI writes into agent configs, and the plugins' launcher, in it. With the real
// npx and a registry on 127.0.0.1 (set in the user's own ~/.npmrc, which must keep working), the
// registry's package runs and nothing planted does; a bare `npx -y knowtarium@<version>` in the
// same folder runs a planted one, which shows the plants work. On Windows, where the command goes
// through cmd.exe, a stand-in npx checks it moves to the profile folder before it looks for npx.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { temporaryFolder } from "../testing/context.js";
import { serverCommand } from "./server-entry.js";

const VERSION = "1.2.3";
const windows = process.platform === "win32";

interface Run {
  readonly code: number | null;
  readonly output: string;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, output: output.replaceAll("\r", "") });
    });
  });
}

/** Plants a `knowtarium` package of the pinned version (and its bin) in `folder`/node_modules. */
async function plantPackage(folder: string, marker: string) {
  const pkg = join(folder, "node_modules", "knowtarium");
  await mkdir(pkg, { recursive: true });
  await mkdir(join(folder, "node_modules", ".bin"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "knowtarium", version: VERSION, bin: { knowtarium: "cli.js" } }),
  );
  await writeFile(join(pkg, "cli.js"), `#!/usr/bin/env node\nconsole.log("${marker}");\n`);
  await chmod(join(pkg, "cli.js"), 0o755);
  await symlink(
    join("..", "knowtarium", "cli.js"),
    join(folder, "node_modules", ".bin", "knowtarium"),
  );
}

async function plantScript(path: string, marker: string) {
  await writeFile(path, `#!/bin/sh\necho "${marker}"\nexit 7\n`);
  await chmod(path, 0o755);
}

describe.skipIf(windows)("a hostile project folder, with the real npx", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let registry: Server | undefined;
  let project = "";
  let env: NodeJS.ProcessEnv = {};

  beforeAll(async () => {
    const folder = await temporaryFolder();
    cleanup = folder.cleanup;
    const root = await realpath(folder.path);
    const home = join(root, "home");
    await mkdir(home);

    // the package the registry serves: it says it is the real one
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: "knowtarium", version: VERSION, bin: { knowtarium: "cli.js" } }),
    );
    await writeFile(
      join(source, "cli.js"),
      `#!/usr/bin/env node\nconsole.log("registry knowtarium ${VERSION} " + process.argv.slice(2).join(" "));\n`,
    );
    const npmEnv = {
      HOME: home,
      PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
    };
    const packed = await run("npm", ["pack", "--pack-destination", root], source, npmEnv);
    expect(packed.code, packed.output).toBe(0);
    const tarball = readFileSync(join(root, `knowtarium-${VERSION}.tgz`));

    registry = createServer((request, response) => {
      const base = `http://127.0.0.1:${String((registry?.address() as AddressInfo).port)}`;
      if (request.url === "/knowtarium") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: "knowtarium",
            "dist-tags": { latest: VERSION },
            versions: {
              [VERSION]: {
                name: "knowtarium",
                version: VERSION,
                bin: { knowtarium: "cli.js" },
                dist: {
                  tarball: `${base}/knowtarium/-/knowtarium-${VERSION}.tgz`,
                  integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
                  shasum: createHash("sha1").update(tarball).digest("hex"),
                },
              },
            },
          }),
        );
      } else if (request.url === `/knowtarium/-/knowtarium-${VERSION}.tgz`) {
        response.end(tarball);
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    await new Promise<void>((resolve) => registry?.listen(0, "127.0.0.1", resolve));
    const port = (registry.address() as AddressInfo).port;
    // the user's own npm settings: the registry comes from here
    await writeFile(
      join(home, ".npmrc"),
      `registry=http://127.0.0.1:${String(port)}/\naudit=false\nfund=false\nupdate-notifier=false\n`,
    );

    // the hostile folder and its parent
    const parent = join(root, "parent");
    project = join(parent, "project");
    await mkdir(project, { recursive: true });
    await plantPackage(parent, "PLANTED parent package");
    await plantPackage(project, "PLANTED project package");
    await plantScript(join(project, "node_modules", ".bin", "node"), "PLANTED node");
    await plantScript(
      join(project, "node_modules", ".bin", `knowtarium@${VERSION}`),
      "PLANTED bin",
    );
    await writeFile(join(project, "evil.cjs"), 'console.log("PLANTED node-options");\n');
    await writeFile(
      join(project, ".npmrc"),
      `node-options=--require ${join(project, "evil.cjs")}\n`,
    );
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "project" }));
    env = npmEnv;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => registry?.close(resolve));
    await cleanup?.();
  });

  it("runs a planted package from a bare npx (the plants work)", async () => {
    const result = await run("npx", ["-y", `knowtarium@${VERSION}`, "mcp"], project, env);
    expect(result.output).toContain("PLANTED");
  }, 60_000);

  it("runs the registry's package from the command agent configs get", async () => {
    const server = serverCommand(VERSION, process.platform);
    const result = await run(server.command, server.args, project, env);
    expect(result.output).not.toContain("PLANTED");
    expect(result.output).toContain(`registry knowtarium ${VERSION} mcp`);
    expect(result.code).toBe(0);
  }, 60_000);

  it("runs the registry's package from the plugins' launcher", async () => {
    const launcher = join(dirname(project), "launch.mjs");
    await copyFile("extras/launch.mjs", launcher);
    const result = await run(
      process.execPath,
      [launcher, "-y", `knowtarium@${VERSION}`, "mcp"],
      project,
      env,
    );
    expect(result.output).not.toContain("PLANTED");
    expect(result.output).toContain(`registry knowtarium ${VERSION} mcp`);
    expect(result.code).toBe(0);
    // npm wrote nothing into the project
    expect((await readdir(project)).sort()).toEqual([
      ".npmrc",
      "evil.cjs",
      "node_modules",
      "package.json",
    ]);
  }, 60_000);

  // a bare `cd` without HOME stays where it is in dash and busybox (Debian's and Alpine's /bin/sh)
  const shells = ["/bin/sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
  it.each(shells)(
    "stops, in %s, when HOME is unset or empty",
    async (shell) => {
      const server = serverCommand(VERSION, process.platform);
      const unset = Object.fromEntries(Object.entries(env).filter(([key]) => key !== "HOME"));
      for (const without of [unset, { ...unset, HOME: "" }]) {
        const result = await run(shell, server.args, project, without);
        expect(result.output).not.toContain("PLANTED");
        expect(result.output).not.toContain("registry knowtarium");
        expect(result.output).toMatch(/HOME/);
        expect(result.code).not.toBe(0);
      }
    },
    60_000,
  );

  it("stops the plugins' launcher when HOME is empty", async () => {
    const launcher = join(dirname(project), "launch.mjs");
    await copyFile("extras/launch.mjs", launcher);
    const result = await run(
      process.execPath,
      [launcher, "-y", `knowtarium@${VERSION}`, "mcp"],
      project,
      { ...env, HOME: "" },
    );
    expect(result.output).not.toContain("PLANTED");
    expect(result.output).toContain("couldn't find your home folder");
    expect(result.code).toBe(1);
  }, 60_000);
});

describe.runIf(windows)("a hostile project folder, on Windows", () => {
  /** A stand-in npx that prints the folder it runs in with `cd`, so it needs no expansion. */
  const plainNpx = (marker: string) => `@echo off\r\necho ${marker}args: %*\r\ncd\r\n`;
  /** One that prints it with delayed expansion, which it turns on itself. */
  const delayedNpx = (marker: string) =>
    `@echo off\r\nsetlocal EnableDelayedExpansion\r\necho ${marker}cwd: !CD!\r\necho args: %*\r\n`;

  /**
   * Runs the agent config's command in a project folder that has an npx of its own, with the
   * stand-in on the PATH and a profile folder whose path cmd would split at the & if it read it
   * before the line is parsed. `profile` false runs it without USERPROFILE.
   */
  async function runConfigured(npx: (marker: string) => string, profile = true) {
    const folder = await temporaryFolder();
    try {
      const root = await realpath(folder.path);
      const home = join(root, "user & home");
      const project = join(root, "project");
      const bin = join(root, "bin");
      for (const path of [home, project, bin]) await mkdir(path, { recursive: true });
      await writeFile(join(bin, "npx.cmd"), npx(""));
      await writeFile(join(project, "npx.cmd"), npx("PLANTED "));
      const server = serverCommand(VERSION, "win32", {
        ...(process.env["ComSpec"] === undefined ? {} : { comSpec: process.env["ComSpec"] }),
        ...(process.env["SystemRoot"] === undefined
          ? {}
          : { systemRoot: process.env["SystemRoot"] }),
      });
      // Windows spells some names its own way (Path); a second key would leave which one wins to
      // chance
      const keyOf = (name: string) =>
        Object.keys(process.env).find((key) => key.toUpperCase() === name) ?? name;
      const environment: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "USERPROFILE"),
      );
      environment[keyOf("PATH")] = `${bin}${delimiter}${process.env[keyOf("PATH")] ?? ""}`;
      if (profile) environment["USERPROFILE"] = home;
      return { home, ...(await run(server.command, server.args, project, environment)) };
    } finally {
      await folder.cleanup();
    }
  }

  it("runs the agent config's npx from the profile folder, never the project's", async () => {
    const result = await runConfigured(delayedNpx);
    expect(result.output).toBe(`cwd: ${result.home}\nargs: -y knowtarium@${VERSION} mcp\n`);
    expect(result.code).toBe(0);
  });

  it("does the same for an npx that doesn't turn delayed expansion on itself", async () => {
    const result = await runConfigured(plainNpx);
    expect(result.output).toBe(`args: -y knowtarium@${VERSION} mcp\n${result.home}\n`);
    expect(result.code).toBe(0);
  });

  it("stops without USERPROFILE instead of staying in the project folder", async () => {
    const result = await runConfigured(plainNpx, false);
    expect(result.output).not.toContain("PLANTED");
    expect(result.output).not.toContain("args:");
    expect(result.code).toBe(1);
  });
});
