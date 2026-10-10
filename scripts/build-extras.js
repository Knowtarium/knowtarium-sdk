// Builds the agent install packages into dist-extras/ (never published from here; see
// RELEASING.md). Run `pnpm build` first.
//
//   knowtarium-<version>.mcpb   Claude Desktop bundle (MCP Bundle manifest v0.3): the built CLI
//                               with its production dependencies, run by Claude Desktop's own
//                               Node (`node server/index.js mcp`), so it needs no terminal and no
//                               Node install. Not connected yet, its `connect` tool opens the
//                               browser. The OS keychain module ships for the main platforms;
//                               elsewhere the CLI keeps its key in a private file. Its manifest
//                               lists every tool, read from the real tool definitions.
//   knowtarium.mcpb             the same file under a stable name, for the GitHub Release's
//                               releases/latest/download/knowtarium.mcpb link
//   SHA256SUMS                  the checksums of both, as `sha256sum -c` reads them
//   marketplace/                the knowtarium-plugins repository, ready to copy over it: a
//                               Claude Code marketplace (.claude-plugin/marketplace.json) and a
//                               Codex one (.agents/plugins/marketplace.json), each with its own
//                               plugin folder (plugins/claude/knowtarium, plugins/codex/knowtarium
//                               in the portable Agent Plugins format) holding the
//                               knowtarium-conventions skill, the MCP server (a launcher that the
//                               MCP config gives `-y knowtarium@<version> mcp`, in plain sight,
//                               and that runs npx with them from the user's home folder, never
//                               the project the client starts it in, on Windows too),
//                               the icon, a README that says what the plugin runs, sends and
//                               stores, and the LICENSE.
//
// Everything points at the package.json version, so a release build refuses a private package,
// version 0.0.0 or a version npm doesn't have. `--dev` builds anyway, labeled as a development
// build everywhere (names, titles, file names); those are never distributed.
//
// The bundle manifest is checked with the official mcpb CLI, the bundled server is started and
// asked for its tools over stdio, the plugins and marketplaces are checked with
// `claude plugin validate --strict` when Claude Code is installed, the Codex plugin against the
// Agent Plugins schemas, and server.json (the MCP Registry entry) against the registry's schema.
// Every tool runs in a throwaway environment (scripts/isolated-env.js).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { build } from "tsdown";

import { isolatedEnvironment } from "./isolated-env.js";

const root = join(import.meta.dirname, "..");
const extras = join(root, "extras");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJson(join(root, "package.json"));
const config = readJson(join(extras, "extras.config.json"));
const serverCommand = readJson(join(root, "src", "cli", "agents", "server-command.json"));
const shrinkwrap = readJson(join(root, "npm-shrinkwrap.json"));
const registryEntry = readJson(join(root, "server.json"));
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
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Fails with every error a JSON schema reports for `value`. */
function assertValid(ajv, schemaFile, value, what) {
  const validate = ajv.compile(readJson(join(extras, "schemas", schemaFile)));
  assert.ok(validate(value), `${what} breaks ${schemaFile}:\n${ajv.errorsText(validate.errors)}`);
}

try {
  assert.ok(existsSync(join(root, "dist", "cli", "index.js")), "run `pnpm build` first");
  assert.equal(
    shrinkwrap.packages[""].version,
    pkg.version,
    "npm-shrinkwrap.json is out of date: run `node scripts/shrinkwrap.js`",
  );

  // the MCP Registry entry names this package at this version (mcp-publisher publishes it as is)
  assert.equal(registryEntry.name, pkg.mcpName, "server.json name must equal mcpName");
  assert.equal(registryEntry.version, pkg.version, "server.json version must equal the package's");
  const [npmEntry] = registryEntry.packages;
  assert.deepEqual(
    [npmEntry.registryType, npmEntry.identifier, npmEntry.version],
    ["npm", pkg.name, pkg.version],
    "server.json must list this npm package at this version",
  );
  const draft7 = new Ajv({ strict: false, allErrors: true });
  addFormats(draft7);
  assertValid(draft7, "mcp-server-2025-12-11.schema.json", registryEntry, "server.json");

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
  const devNote = (text) => (dev ? `Development build, not for distribution. ${text}` : text);
  const description = devNote(config.description);
  const agentDescription = devNote(config.agentDescription);
  const npxArgs = serverCommand.npxArgs.map((arg) => arg.replace("{version}", pkg.version));
  // the exact version, in plain sight in the plugins' MCP configs (a directory scanner reads them)
  assert.ok(npxArgs.includes(`${pkg.name}@${pkg.version}`), "the server command pins this version");
  // the launcher refuses anything else, so cmd on Windows never reads an argument as a command
  for (const arg of npxArgs) assert.match(arg, /^[\w@.\-/=:]+$/, "a plain launcher argument");
  rmSync(out, { recursive: true, force: true });

  // ---- every tool the server can offer, from the real tool definitions (src/cli/mcp/catalog.ts)
  const catalogOut = join(out, ".catalog");
  await build({
    config: false,
    cwd: root,
    entry: { catalog: join(root, "src", "cli", "mcp", "catalog.ts") },
    outDir: catalogOut,
    format: "esm",
    platform: "node",
    target: "es2023",
    tsconfig: join(root, "src", "cli", "tsconfig.json"),
    dts: false,
    logLevel: "warn",
  });
  const catalogFile = readdirSync(catalogOut).find((file) => /^catalog\.m?js$/.test(file));
  assert.ok(catalogFile !== undefined, "the tool catalog didn't build");
  const { toolCatalog } = await import(pathToFileURL(join(catalogOut, catalogFile)).href);
  const catalog = await toolCatalog();
  rmSync(catalogOut, { recursive: true, force: true });
  assert.ok(catalog.length > 0, "the tool catalog is empty");

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
  copyFileSync(join(extras, "icon.png"), join(bundle, "icon.png"));

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
    documentation: config.documentation,
    support: config.support,
    license: pkg.license,
    privacy_policies: [config.privacyPolicy],
    keywords: ["knowledge base", "notes", "okf", "verification", "encryption"],
    icon: "icon.png",
    icons: [{ src: "icon.png", size: "512x512" }],
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: { command: "node", args: ["${__dirname}/server/index.js", "mcp"] },
    },
    // every tool the server can offer; which of them a session has depends on its connection
    // (`connect` only until one is made, the writing tools only for one that may write), and the
    // list changes while it runs, so the tools are also generated
    tools: catalog.map((tool) => ({ name: tool.name, description: tool.description })),
    tools_generated: true,
    compatibility: {
      // the floor the official build-mcpb skill uses for manifest 0.3 bundles
      claude_desktop: `>=${config.claudeDesktopMinimum}`,
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

  const versioned = `knowtarium-${pkg.version}${label}.mcpb`;
  const stable = `knowtarium${label}.mcpb`;
  const file = join(out, versioned);
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
  const offered = started.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((answer) => answer.id === 2)?.result?.tools;
  assert.ok(
    offered?.some((tool) => tool.name === "connect"),
    `the bundled server offers no connect tool:\n${started.output}`,
  );
  // what the unconnected bundle offers is in the manifest, word for word
  for (const tool of offered) {
    const listed = manifest.tools.find((entry) => entry.name === tool.name);
    assert.equal(listed?.description, tool.description, `manifest tools: ${tool.name} differs`);
  }
  copyFileSync(file, join(out, stable));
  write(join(out, "SHA256SUMS"), `${sha256(file)}  ${versioned}\n${sha256(file)}  ${stable}\n`);

  process.stdout.write(
    `built ${file} and ${stable} (manifest valid with ${String(manifest.tools.length)} tools, server starts)\n`,
  );

  // ---- the plugins repository: one marketplace for Claude Code and one for Codex
  const marketplace = join(out, "marketplace");
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  const mcpbUrl = `${config.repository}/releases/latest/download/knowtarium.mcpb`;
  const readme = (template) =>
    readFileSync(join(extras, "readme", template), "utf8").replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const value = {
        version: pkg.version,
        repository: config.repository,
        apiHost: config.apiHost,
        privacyPolicy: config.privacyPolicy,
        termsOfService: config.termsOfService,
        support: config.support,
        email: config.author.email,
        mcpbUrl,
      }[key];
      assert.ok(value !== undefined, `readme ${template}: unknown {{${key}}}`);
      return value;
    });
  const devReadme = (text) =>
    dev ? `> Development build of ${pkg.version}, not for distribution.\n\n${text}` : text;
  /** What both plugins hold: the launcher, the skill, the icon, the README and the license. */
  const pluginBase = (folder, template) => {
    mkdirSync(join(folder, "server"), { recursive: true });
    copyFileSync(join(extras, "launch.mjs"), join(folder, "server", "launch.mjs"));
    cpSync(
      join(root, "skills", "knowtarium-conventions"),
      join(folder, "skills", "knowtarium-conventions"),
      { recursive: true },
    );
    mkdirSync(join(folder, "assets"), { recursive: true });
    copyFileSync(join(extras, "icon.png"), join(folder, "assets", "icon.png"));
    write(join(folder, "README.md"), devReadme(readme(template)));
    write(join(folder, "LICENSE"), license);
  };
  write(join(marketplace, "README.md"), devReadme(readme("marketplace.md")));
  write(join(marketplace, "LICENSE"), license);
  write(join(marketplace, ".gitignore"), ".DS_Store\nThumbs.db\n");

  // Claude Code: .claude-plugin/plugin.json and .mcp.json, paths from ${CLAUDE_PLUGIN_ROOT}
  const claudePath = `plugins/claude/${name}`;
  const claudePlugin = join(marketplace, claudePath);
  pluginBase(claudePlugin, "claude-plugin.md");
  write(
    join(claudePlugin, ".claude-plugin", "plugin.json"),
    json({
      name,
      displayName,
      // the version lives here only: a marketplace entry's version would be overridden by it
      version: pkg.version,
      description,
      author: config.author,
      homepage: config.homepage,
      repository: config.repository,
      license: pkg.license,
      keywords: config.keywords,
      icon: "./assets/icon.png",
      documentationUrl: config.documentation,
      supportUrl: config.support,
      privacyPolicyUrl: config.privacyPolicy,
      termsOfServiceUrl: config.termsOfService,
    }),
  );
  write(
    join(claudePlugin, ".mcp.json"),
    json({
      mcpServers: {
        knowtarium: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/server/launch.mjs", ...npxArgs],
        },
      },
    }),
  );
  write(
    join(marketplace, ".claude-plugin", "marketplace.json"),
    json({
      name,
      owner: { name: config.author.name, email: config.author.email, url: config.author.url },
      description: dev
        ? `${displayName}, not for distribution`
        : `${displayName}: your end-to-end encrypted knowledge base in Claude Code`,
      plugins: [{ name, source: `./${claudePath}`, description, category: "productivity" }],
    }),
  );

  // Codex: the portable Agent Plugins format (root plugin.json and mcp.json, ${PLUGIN_ROOT}),
  // with Codex's own presentation under extensions["com.openai"]
  const codexPath = `plugins/codex/${name}`;
  const codexPlugin = join(marketplace, codexPath);
  pluginBase(codexPlugin, "codex-plugin.md");
  const codexManifest = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
    version: pkg.version,
    description: agentDescription,
    author: config.author,
    homepage: config.homepage,
    repository: config.repository,
    license: pkg.license,
    keywords: config.keywords,
    extensions: {
      "com.openai": {
        interface: {
          displayName,
          shortDescription: config.shortDescription,
          longDescription: agentDescription,
          developerName: config.author.name,
          category: "Productivity",
          capabilities: ["Read", "Write"],
          websiteURL: config.homepage,
          supportURL: config.support,
          privacyPolicyURL: config.privacyPolicy,
          termsOfServiceURL: config.termsOfService,
          defaultPrompt: config.defaultPrompts,
          brandColor: config.brandColor,
          composerIcon: "./assets/icon.png",
          logo: "./assets/icon.png",
        },
      },
    },
  };
  const codexMcp = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      knowtarium: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/server/launch.mjs", ...npxArgs],
      },
    },
  };
  write(join(codexPlugin, "plugin.json"), json(codexManifest));
  write(join(codexPlugin, "mcp.json"), json(codexMcp));
  const codexMarketplace = {
    name,
    interface: { displayName },
    plugins: [
      {
        name,
        source: { source: "local", path: `./${codexPath}` },
        // Knowtarium connects through its own `connect` tool (or `npx knowtarium connect`) the
        // first time it is used, not through a sign-in when the plugin is installed
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  };
  write(join(marketplace, ".agents", "plugins", "marketplace.json"), json(codexMarketplace));

  // the Codex plugin against the Agent Plugins schemas (vendored in extras/schemas); its
  // marketplace has no published schema, so its shape is checked here as Codex documents it
  const draft2020 = new Ajv2020({ strict: false, allErrors: true });
  addFormats(draft2020);
  assertValid(draft2020, "agent-plugins-1.0.0-plugin.schema.json", codexManifest, "plugin.json");
  assertValid(draft2020, "agent-plugins-1.0.0-mcp.schema.json", codexMcp, "mcp.json");
  for (const entry of codexMarketplace.plugins) {
    assert.match(entry.source.path, /^\.\/[\w./-]+$/, "a Codex source path starts with ./");
    assert.ok(existsSync(join(marketplace, entry.source.path, "plugin.json")), entry.name);
    assert.ok(
      ["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(entry.policy.installation),
    );
    assert.ok(["ON_INSTALL", "ON_USE"].includes(entry.policy.authentication));
    assert.equal(typeof entry.category, "string");
  }
  // every path the Codex manifest names is in the plugin
  const { interface: codexInterface } = codexManifest.extensions["com.openai"];
  for (const asset of [codexInterface.composerIcon, codexInterface.logo]) {
    assert.ok(existsSync(join(codexPlugin, asset)), `the Codex plugin has no ${asset}`);
  }
  // the directory's limits (developers.openai.com/plugins/deploy/submission)
  const within = (field, value, most) =>
    assert.ok(value.length <= most, `Codex interface.${field} is over ${String(most)} characters`);
  within("displayName", codexInterface.displayName, dev ? 60 : 30);
  within("shortDescription", codexInterface.shortDescription, 30);
  within("longDescription", codexInterface.longDescription, 4000);
  assert.ok(codexInterface.defaultPrompt.length <= 3, "at most three Codex default prompts");
  for (const prompt of codexInterface.defaultPrompt) within("defaultPrompt", prompt, 128);
  for (const url of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    assert.match(codexInterface[url], /^https:\/\//, `Codex interface.${url} is an https URL`);
  }

  const claude = run("claude", ["--version"]);
  if (claude.status === 0) {
    for (const target of [claudePlugin, marketplace]) {
      const checked = run("claude", ["plugin", "validate", "--strict", target]);
      assert.equal(
        checked.status,
        0,
        `claude plugin validate failed for ${target}:\n${checked.output}`,
      );
    }
    process.stdout.write(
      `built ${marketplace} (Claude Code plugin and marketplace valid, Codex plugin matches the Agent Plugins schemas)\n`,
    );
  } else {
    process.stdout.write(
      `built ${marketplace} (Codex plugin matches the Agent Plugins schemas); Claude Code isn't installed, so validate the rest with:\n  claude plugin validate --strict ${claudePlugin}\n  claude plugin validate --strict ${marketplace}\n`,
    );
  }
} catch (error) {
  if (!(error instanceof RefusedBuild)) throw error;
} finally {
  cleanup();
}
