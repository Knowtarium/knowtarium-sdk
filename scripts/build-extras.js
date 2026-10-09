// Builds the agent install packages into dist-extras/ (never published from here; see
// RELEASING.md). Run `pnpm build` first.
//
//   knowtarium-<version>.mcpb   Claude Desktop bundle (MCP Bundle manifest v0.3): the built CLI
//                               with its production dependencies, run by Claude Desktop's own
//                               Node (`node server/index.js mcp`), so it needs no terminal and no
//                               Node install. Not connected yet, its `connect` tool opens the
//                               browser. The OS keychain module ships for the main platforms;
//                               elsewhere the CLI keeps its key in a private file.
//   claude-plugin/              a local Claude Code marketplace with the `knowtarium` plugin: its
//                               manifest, the knowtarium-conventions skill, and the MCP server
//                               (`node ${CLAUDE_PLUGIN_ROOT}/server/launch.mjs`, which runs
//                               `npx -y knowtarium@<version> mcp`, so native Windows works too).
//
// Both point at the package.json version, so a release build refuses a private package, version
// 0.0.0 or a version npm doesn't have. `--dev` builds anyway, labeled as a development build
// everywhere (names, titles, file names); those are never distributed.
//
// The bundle manifest is checked with the official mcpb CLI, the bundled server is started and
// asked for its tools over stdio, and the plugin and marketplace are checked with
// `claude plugin validate --strict` when Claude Code is installed. Every tool runs in a throwaway
// environment (scripts/isolated-env.js).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { isolatedEnvironment } from "./isolated-env.js";

const root = join(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJson(join(root, "package.json"));
const config = readJson(join(root, "extras", "extras.config.json"));
const serverCommand = readJson(join(root, "src", "cli", "agents", "server-command.json"));
const shrinkwrap = readJson(join(root, "npm-shrinkwrap.json"));
const dev = process.argv.includes("--dev");
const out = join(root, "dist-extras");
const { sandbox, env, cleanup } = isolatedEnvironment("knowtarium-extras-");

/** A release build refused (the reason is printed); the sandbox is still removed. */
class RefusedBuild extends Error {}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 300_000, ...options });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

try {
  assert.ok(existsSync(join(root, "dist", "cli", "index.js")), "run `pnpm build` first");
  assert.equal(
    shrinkwrap.packages[""].version,
    pkg.version,
    "npm-shrinkwrap.json is out of date: run `node scripts/shrinkwrap.js`",
  );

  // a release build only for a version people can install
  if (!dev) {
    const problems = [];
    if (pkg.private === true) problems.push("package.json is private");
    if (pkg.version === "0.0.0") problems.push("the version is the 0.0.0 placeholder");
    const published = run("npm", ["view", `${pkg.name}@${pkg.version}`, "version"]);
    if (published.status !== 0 || published.stdout.trim() !== pkg.version) {
      problems.push(`${pkg.name}@${pkg.version} isn't on npm`);
    }
    if (problems.length > 0) {
      process.stderr.write(
        `build:extras refuses a release build: ${problems.join("; ")}.\nPublish the package first (RELEASING.md), or pass --dev for a labeled development build that is never distributed.\n`,
      );
      process.exitCode = 1;
      throw new RefusedBuild();
    }
  }

  const label = dev ? "-dev" : "";
  const name = `knowtarium${label}`;
  const displayName = dev ? `${config.displayName} (development build)` : config.displayName;
  const description = dev
    ? `Development build, not for distribution. ${config.description}`
    : config.description;
  const npxArgs = serverCommand.npxArgs.map((arg) => arg.replace("{version}", pkg.version));
  rmSync(out, { recursive: true, force: true });

  // ---- the Claude Desktop bundle: the CLI and its production dependencies
  const bundle = join(out, "mcpb");
  const server = join(bundle, "server");
  write(
    join(server, "package.json"),
    json({
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      license: pkg.license,
      engines: pkg.engines,
      dependencies: pkg.dependencies,
    }),
  );
  copyFileSync(join(root, "npm-shrinkwrap.json"), join(server, "npm-shrinkwrap.json"));
  const installed = run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: server });
  assert.equal(installed.status, 0, `npm ci failed:\n${installed.output}`);
  // the keychain module's binaries for every main platform, checked against the shrinkwrap
  const packs = join(sandbox, "packs");
  mkdirSync(packs, { recursive: true });
  for (const platform of config.keyringPlatforms) {
    const id = `@napi-rs/keyring-${platform}`;
    const locked = shrinkwrap.packages[`node_modules/${id}`];
    assert.ok(locked !== undefined, `${id} isn't in npm-shrinkwrap.json`);
    const target = join(server, "node_modules", "@napi-rs", `keyring-${platform}`);
    if (existsSync(target)) continue;
    const packed = run("npm", [
      "pack",
      `${id}@${locked.version}`,
      "--json",
      "--pack-destination",
      packs,
    ]);
    assert.equal(packed.status, 0, `npm pack ${id} failed:\n${packed.output}`);
    const [info] = JSON.parse(packed.stdout);
    assert.equal(info.integrity, locked.integrity, `${id}: integrity differs from the shrinkwrap`);
    mkdirSync(target, { recursive: true });
    const extracted = run("tar", [
      "-xzf",
      join(packs, info.filename),
      "-C",
      target,
      "--strip-components=1",
    ]);
    assert.equal(extracted.status, 0, `extracting ${id} failed:\n${extracted.output}`);
  }
  copyFileSync(join(root, "dist", "cli", "index.js"), join(server, "index.js"));
  rmSync(join(server, "npm-shrinkwrap.json"));
  // the comet mark (a copy of the landing site's app icon, 512 x 512)
  copyFileSync(join(root, "extras", "icon.png"), join(bundle, "icon.png"));

  const manifest = {
    manifest_version: "0.3",
    name,
    display_name: displayName,
    version: pkg.version,
    description,
    long_description:
      "Connects Claude to your Knowtarium workspace. Ask Claude to connect Knowtarium: the browser opens, you sign in and approve this computer, and no password, token or key goes in Claude's settings. Notes stay end-to-end encrypted; Claude's changes are saved as its own and you can undo them, or, in folders that ask for approval, they wait for you.",
    author: config.author,
    repository: { type: "git", url: config.repository },
    homepage: config.homepage,
    license: pkg.license,
    privacy_policies: [config.privacyPolicy],
    keywords: ["knowledge base", "notes", "okf", "verification", "encryption"],
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: { command: "node", args: ["${__dirname}/server/index.js", "mcp"] },
    },
    tools_generated: true,
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      // Claude Desktop runs the bundle on its own Node, whose version we don't control: the lowest
      // one the server is checked on (scripts/check-node.js), the same floor as the CLI's engines
      runtimes: { node: `>=${config.bundleNodeMinimum}` },
    },
  };
  write(join(bundle, "manifest.json"), json(manifest));
  const mcpb = join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
  const validated = run(process.execPath, [mcpb, "validate", join(bundle, "manifest.json")]);
  assert.equal(validated.status, 0, `mcpb validate failed:\n${validated.output}`);

  const file = join(out, `knowtarium-${pkg.version}${label}.mcpb`);
  const packed = run(process.execPath, [mcpb, "pack", bundle, file]);
  assert.equal(packed.status, 0, `mcpb pack failed:\n${packed.output}`);
  // the packed bundle, unpacked, starts with only what it holds and offers `connect`
  const exchange = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "build-extras", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  const unpacked = join(sandbox, "unpacked");
  const opened = run(process.execPath, [mcpb, "unpack", file, unpacked]);
  assert.equal(opened.status, 0, `mcpb unpack failed:\n${opened.output}`);
  const started = run(process.execPath, [join(unpacked, "server", "index.js"), "mcp"], {
    cwd: sandbox,
    input: `${exchange.map((message) => JSON.stringify(message)).join("\n")}\n`,
    timeout: 60_000,
  });
  assert.equal(started.status, 0, `the bundled server failed:\n${started.output}`);
  const tools = started.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((answer) => answer.id === 2)
    ?.result?.tools.map((tool) => tool.name);
  assert.ok(
    tools?.includes("connect"),
    `the bundled server offers no connect tool:\n${started.output}`,
  );

  process.stdout.write(`built ${file} (manifest valid, server starts)\n`);

  // ---- the Claude Code plugin, in a local marketplace
  const marketplace = join(out, "claude-plugin");
  const plugin = join(marketplace, name);
  write(
    join(plugin, ".claude-plugin", "plugin.json"),
    json({
      name,
      version: pkg.version,
      description,
      author: config.author,
      homepage: config.homepage,
      repository: config.repository,
      license: pkg.license,
      keywords: ["knowledge-base", "notes", "okf", "mcp", "verification"],
    }),
  );
  write(
    join(plugin, ".mcp.json"),
    json({
      mcpServers: {
        knowtarium: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/launch.mjs"] },
      },
    }),
  );
  write(join(plugin, "server", "server-command.json"), json({ args: npxArgs }));
  copyFileSync(join(root, "extras", "launch.mjs"), join(plugin, "server", "launch.mjs"));
  cpSync(
    join(root, "skills", "knowtarium-conventions"),
    join(plugin, "skills", "knowtarium-conventions"),
    { recursive: true },
  );
  write(
    join(marketplace, ".claude-plugin", "marketplace.json"),
    json({
      name,
      owner: { name: config.author.name },
      description: dev ? `${displayName}, not for distribution` : `${displayName} for Claude Code`,
      plugins: [{ name, source: `./${name}`, description, version: pkg.version }],
    }),
  );
  const claude = run("claude", ["--version"]);
  if (claude.status === 0) {
    for (const target of [plugin, marketplace]) {
      const checked = run("claude", ["plugin", "validate", "--strict", target]);
      assert.equal(
        checked.status,
        0,
        `claude plugin validate failed for ${target}:\n${checked.output}`,
      );
    }
    process.stdout.write(`built ${marketplace} (plugin and marketplace valid)\n`);
  } else {
    process.stdout.write(
      `built ${marketplace}; Claude Code isn't installed, so validate it with:\n  claude plugin validate --strict ${plugin}\n  claude plugin validate --strict ${marketplace}\n`,
    );
  }
} catch (error) {
  if (!(error instanceof RefusedBuild)) throw error;
} finally {
  cleanup();
}
