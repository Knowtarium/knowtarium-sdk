// Checks the built package the way a consumer sees it. Every subpath in package.json "exports"
// is imported by name (Node resolves a package's own name through its "exports"), each has its
// .d.ts, core edits a note without touching other bytes and imports nothing platform specific,
// the client reaches only libsodium, zod, yaml and jsdiff, the built crypto entry reproduces the
// committed vectors, the binary runs (in a throwaway home: it never sees the real agent configs,
// the OS keychain or the production API), and knowtarium/protocol (all the sync API imports)
// shares no module with knowtarium/crypto and never imports libsodium.
// Run `pnpm build` first.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

assert.ok(existsSync(dist), "dist/ is missing: run `pnpm build` first");

for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (typeof target === "string") continue; // "./package.json"
  const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
  assert.ok(existsSync(join(root, target.types)), `${specifier}: ${target.types} is missing`);
  await import(specifier);
}

const core = await import("knowtarium/core");
assert.equal(core.OKF_SPEC_VERSION, "0.2");
assert.equal(core.isReservedFile("index.md"), true);

const note = core.parseNote("---\ntitle: A # keep\n---\nBody\n");
assert.equal(
  core.addVerified(note, "human:a", "2026-09-30T12:00:00Z").text,
  "---\ntitle: A # keep\nverified:\n  - { by: human:a, at: 2026-09-30T12:00:00Z }\n---\nBody\n",
  "knowtarium/core edits frontmatter without touching other bytes",
);

// the built crypto entry loads libsodium and reproduces the committed vectors
const crypto = await import("knowtarium/crypto");
const vectors = JSON.parse(readFileSync(join(root, "src/crypto/vectors.json"), "utf8"));
const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
await crypto.ready();
for (const vector of vectors.envelope) {
  const key = { generation: vector.generation, key: fromHex(vector.key) };
  const plaintext = crypto.decryptBytes(key, fromHex(vector.blob), vector.context);
  assert.equal(Buffer.from(plaintext).toString("hex"), vector.plaintext, vector.name);
}
for (const vector of vectors.signedEvents) {
  const signed = { version: 1, event: vector.event, signature: vector.signature };
  assert.ok(crypto.verifyEvent(signed, fromHex(vector.publicKey)), vector.name);
}
const envelopeVectors = JSON.parse(
  readFileSync(join(root, "src/crypto/envelope-vectors.json"), "utf8"),
);
for (const vector of envelopeVectors.signedEnvelopes) {
  const signed = { version: 1, envelope: vector.fields, signature: vector.signature };
  assert.ok(crypto.verifyEnvelope(signed, fromHex(vector.publicKey)), vector.name);
}
for (const vector of vectors.connectPayloads) {
  const keyPair = crypto.boxKeyPairFromPrivateKey(fromHex(vector.cliPrivateKey));
  const opened = crypto.openConnectPayload(fromHex(vector.sealed), {
    secret: fromHex(vector.secret),
    keyPair,
  });
  assert.equal(opened.confirmationCode, vector.expected.confirmationCode, vector.name);
}
// only the verified path to a workspace key is public
assert.equal(crypto.unwrapWorkspaceKey, undefined, "unwrapWorkspaceKey is not exported");
for (const vector of vectors.signedWrappedKeys) {
  const recipient = crypto.boxKeyPairFromPrivateKey(fromHex(vector.recipientPrivateKey));
  const signedKey = {
    wrapped: fromHex(vector.wrapped),
    signed: vector.signed,
    signedGeneration: vector.signedGeneration,
  };
  const key = crypto.unwrapSignedWorkspaceKey(signedKey, recipient, {
    ownerSigningPublicKey: fromHex(vector.ownerSigningPublicKey),
    workspaceId: vector.workspaceId,
  });
  assert.equal(Buffer.from(key.key).toString("hex"), vector.key, vector.name);
}

// the published CLI pins its transitive dependencies: npm-shrinkwrap.json matches package.json
const shrinkwrap = JSON.parse(readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"));
assert.equal(
  shrinkwrap.packages[""].version,
  pkg.version,
  "npm-shrinkwrap.json: run scripts/shrinkwrap.js",
);
assert.deepEqual(
  shrinkwrap.packages[""].dependencies,
  pkg.dependencies,
  "npm-shrinkwrap.json doesn't match package.json dependencies: run scripts/shrinkwrap.js",
);
assert.ok(pkg.files.includes("npm-shrinkwrap.json"), "package.json files must ship the shrinkwrap");

const protocolEntry = await import("knowtarium/protocol");
assert.equal(protocolEntry.PROTOCOL_VERSION, 2);
assert.equal(protocolEntry.PROTOCOL_HEADER, "Knowtarium-Protocol-Version");
assert.equal(protocolEntry.routes.health.path, "/health");
assert.equal(protocolEntry.isJitless(), true, "knowtarium/protocol makes zod jitless on load");
assert.ok(protocolEntry.ROUTE_LIST.length > 0, "knowtarium/protocol has no routes");

const main = await import("knowtarium");
assert.equal(main.isReservedFile, core.isReservedFile, "the root entry re-exports core");

/** Every dist/ file an entry reaches through static and dynamic imports, plus any bare specifiers. */
function importGraph(entry) {
  const files = new Set();
  const bare = new Set();
  const pending = [join(dist, entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    // `from` only after whitespace, `}` or `*`: a string like "linked-from" is not an import
    for (const [, specifier] of text.matchAll(
      /(?:(?<=[\s}*])from|\bimport)\s*\(?\s*["']([^"'\n]+)["']/g,
    )) {
      if (specifier.startsWith(".")) pending.push(join(dirname(file), specifier));
      else bare.add(specifier);
    }
  }
  return { files: [...files].map((file) => relative(dist, file)), bare: [...bare] };
}

const protocol = importGraph("protocol/index.js");
const cryptoGraph = importGraph("crypto/index.js");
assert.ok(cryptoGraph.bare.includes("libsodium-wrappers-sumo"), "knowtarium/crypto uses libsodium");
const shared = protocol.files.filter((file) => cryptoGraph.files.includes(file));
assert.deepEqual(shared, [], "knowtarium/protocol pulls in modules of knowtarium/crypto");
for (const specifier of protocol.bare) {
  assert.ok(
    !/^(node:)?crypto$|^libsodium/.test(specifier),
    `knowtarium/protocol imports ${specifier}`,
  );
}

// knowtarium/core runs in browsers too: its only outside imports are its four dependencies
for (const specifier of importGraph("core/index.js").bare) {
  assert.ok(
    ["yaml", "zod", "minisearch", "diff"].includes(specifier),
    `knowtarium/core imports ${specifier}`,
  );
}
const searchIndex = core.createSearchIndex(
  core
    .createWorkspace([{ id: "a", path: "a.md", text: "# Pricing\n\nChurn is 2.4%.\n" }])
    .notes.values(),
);
assert.equal(searchIndex.search("churn")[0]?.id, "a", "knowtarium/core searches from dist");

// knowtarium/client runs in browsers and the CLI: it reaches only libsodium, zod and what core's
// history module needs (yaml, jsdiff), and ships none of its test helpers
const client = await import("knowtarium/client");
for (const name of [
  "createApiClient",
  "SyncEngine",
  "TrustState",
  "EncryptedCache",
  "IndexedDbTrustStorage",
  "IndexedDbCacheAdapter",
]) {
  assert.equal(typeof client[name], "function", `knowtarium/client exports ${name}`);
}
assert.equal(client.FakeServer, undefined, "knowtarium/client ships no test helpers");
for (const specifier of importGraph("client/index.js").bare) {
  assert.ok(
    ["libsodium-wrappers-sumo", "zod", "yaml", "diff"].includes(specifier),
    `knowtarium/client imports ${specifier}`,
  );
}

// the binary, run in a throwaway home with the keychain off and an API that isn't there
const sandbox = mkdtempSync(join(tmpdir(), "knowtarium-dist-"));
const isolated = {
  PATH: process.env.PATH ?? "",
  ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  HOME: join(sandbox, "user"),
  USERPROFILE: join(sandbox, "user"),
  APPDATA: join(sandbox, "user", "roaming"),
  LOCALAPPDATA: join(sandbox, "user", "local"),
  XDG_CONFIG_HOME: join(sandbox, "user", "config"),
  XDG_CACHE_HOME: join(sandbox, "user", "cache"),
  KNOWTARIUM_HOME: join(sandbox, "home"),
  KNOWTARIUM_CACHE: join(sandbox, "cache"),
  KNOWTARIUM_KEYCHAIN: "off",
  KNOWTARIUM_API_URL: "http://127.0.0.1:9",
  KNOWTARIUM_APP_URL: "http://127.0.0.1:9",
};
const bin = (...args) => binWith("", ...args);
const binWith = (input, ...args) => {
  const run = spawnSync(process.execPath, [join(root, pkg.bin.knowtarium), ...args], {
    encoding: "utf8",
    env: isolated,
    input,
    timeout: 30_000,
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
};
try {
  const help = bin();
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /^knowtarium: /);
  assert.equal(bin("--version").out.trim(), pkg.version);
  // the binary checks an OKF folder offline (the migration skill's validator)
  const validated = bin("validate", join(root, "test/fixtures/import/okf-plain"));
  assert.equal(validated.code, 0, validated.err);
  assert.match(validated.out, /0 errors, 0 warnings\./);
  // the migration command converts a vault into a new folder whose result validates
  const converted = join(sandbox, "converted");
  const convert = bin(
    "convert",
    join(root, "test/fixtures/import/obsidian-messy"),
    converted,
    "--person",
    "maya",
  );
  assert.equal(convert.code, 0, convert.err);
  assert.match(bin("validate", converted).out, /0 errors/);
  const status = bin("status", "--offline");
  assert.equal(status.code, 0, status.err);
  // agent configs name a command that exists: the written one runs and says it isn't connected
  const agents = bin("agents", "--agent", "cursor");
  assert.equal(agents.code, 0, agents.err);
  const cursor = JSON.parse(readFileSync(join(isolated.HOME, ".cursor", "mcp.json"), "utf8"));
  const entry = cursor.mcpServers.knowtarium;
  // npx runs from the home folder, never the folder the agent starts it in (server-entry.ts)
  const script = entry.args.at(-1);
  assert.ok(
    script.includes(` npx -y knowtarium@${pkg.version} mcp`),
    `the agent's command pins this version: ${script}`,
  );
  // and adds the folder of the Node.js that wrote it, which holds npx, to the end of the PATH
  const nodeFolder = dirname(process.execPath);
  if (process.platform === "win32") {
    assert.match(entry.command, /\\cmd\.exe$/i);
    assert.ok(script.startsWith("if defined USERPROFILE (cd /d !USERPROFILE!&& "), script);
    if (existsSync(join(nodeFolder, "npx.cmd"))) {
      assert.ok(script.includes(` set PATH=!PATH!;${nodeFolder}&& npx `), script);
    }
  } else {
    assert.equal(entry.command, "/bin/sh");
    assert.ok(script.startsWith('[ -n "$HOME" ] && cd -- "$HOME" && '), script);
    assert.ok(!script.includes("${"), script);
    if (existsSync(join(nodeFolder, "npx"))) {
      assert.ok(script.includes(` export PATH="$PATH:${nodeFolder}" && exec npx `), script);
    }
  }
  // a real MCP exchange over stdio: with nothing connected the server still answers, and the
  // tools point to its `connect` tool
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "check-dist", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_workspaces" } },
  ];
  const mcp = binWith(messages.map((message) => JSON.stringify(message)).join("\n") + "\n", "mcp");
  assert.equal(mcp.code, 0, mcp.err);
  assert.match(mcp.err, /not connected/);
  const answers = mcp.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(answers.find((answer) => answer.id === 1)?.result?.serverInfo?.name, "knowtarium");
  const listed = answers.find((answer) => answer.id === 2)?.result;
  assert.equal(listed?.isError, true, "list_workspaces says nothing is connected");
  assert.match(listed.content[0].text, /`connect` tool/);
  assert.equal(bin("agents", "--agent", "nope").code, 2);
  // a CLI that never connected made no key
  assert.equal(existsSync(join(isolated.KNOWTARIUM_HOME, "secrets.json")), false);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

process.stdout.write(`dist OK: ${Object.keys(pkg.exports).join(", ")} and the knowtarium bin\n`);
