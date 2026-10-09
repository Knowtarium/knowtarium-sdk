// Runs the built CLI and the Claude Desktop bundle's server under other Node versions, to find
// and keep the lowest one they work on (the bundle runs on Claude Desktop's own Node, whose
// version isn't documented). Pass Node binaries; nothing is installed or changed:
//
//   node scripts/check-node.js /path/to/node-v20.0.0/bin/node /path/to/node-v22/bin/node
//
// For each, in a throwaway environment: `knowtarium --version`, `validate` on the plain OKF
// fixture, `status --offline`, and an MCP exchange over stdio (initialize, tools/list, a tool
// call answering that nothing is connected), with the CLI from dist/ and, when
// `pnpm build:extras --dev` built one, with the server inside the unpacked .mcpb.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { isolatedEnvironment } from "./isolated-env.js";

const root = join(import.meta.dirname, "..");
const nodes = process.argv.slice(2);
assert.ok(nodes.length > 0, "pass one or more Node binaries");
const mcpb = join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
const bundle = existsSync(join(root, "dist-extras"))
  ? readdirSync(join(root, "dist-extras")).find((name) => name.endsWith(".mcpb"))
  : undefined;

const exchange = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "check-node", version: "1.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_workspaces" } },
];

const { sandbox, env, cleanup } = isolatedEnvironment("knowtarium-check-node-");
let failed = false;
try {
  const servers = [["dist", join(root, "dist", "cli", "index.js")]];
  if (bundle !== undefined) {
    const unpacked = join(sandbox, "unpacked");
    const opened = spawnSync(
      process.execPath,
      [mcpb, "unpack", join(root, "dist-extras", bundle), unpacked],
      {
        env,
        encoding: "utf8",
      },
    );
    assert.equal(opened.status, 0, opened.stderr);
    servers.push([bundle, join(unpacked, "server", "index.js")]);
  }
  for (const node of nodes) {
    const version = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim();
    for (const [label, entry] of servers) {
      const run = (args, input = "") =>
        spawnSync(node, [entry, ...args], { env, encoding: "utf8", input, timeout: 60_000 });
      const problems = [];
      const checks = [
        ["--version", run(["--version"]), (out) => out.trim().length > 0],
        [
          "validate",
          run(["validate", join(root, "test/fixtures/import/okf-plain")]),
          (out) => out.includes("0 errors, 0 warnings."),
        ],
        ["status --offline", run(["status", "--offline"]), () => true],
        [
          "mcp",
          run(["mcp"], `${exchange.map((message) => JSON.stringify(message)).join("\n")}\n`),
          (out) => {
            const answers = out
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            const tools = answers.find((answer) => answer.id === 2)?.result?.tools ?? [];
            const call = answers.find((answer) => answer.id === 3)?.result;
            return tools.some((tool) => tool.name === "connect") && call?.isError === true;
          },
        ],
      ];
      for (const [name, result, ok] of checks) {
        let passed = result.status === 0;
        try {
          passed &&= ok(result.stdout);
        } catch {
          passed = false;
        }
        if (!passed) problems.push(`${name}: ${(result.stderr || result.stdout).split("\n")[0]}`);
      }
      failed ||= problems.length > 0;
      process.stdout.write(
        `${version} ${label}: ${problems.length === 0 ? "OK" : `FAILED\n  ${problems.join("\n  ")}`}\n`,
      );
    }
  }
} finally {
  cleanup();
}
process.exitCode = failed ? 1 : 0;
