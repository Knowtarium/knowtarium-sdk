// Writes npm-shrinkwrap.json for the published CLI, so `npx knowtarium@<version>` installs the
// exact transitive versions tested here instead of whatever the ranges resolve to that day. npm
// resolves the production dependencies of package.json in a throwaway folder (no dev
// dependencies, no install scripts) and the lock is copied back. Run it whenever dependencies or
// the version change (see RELEASING.md); `pnpm test:dist` fails when it is out of date.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { isolatedEnvironment } from "./isolated-env.js";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { sandbox, env, cleanup } = isolatedEnvironment("knowtarium-shrinkwrap-");
try {
  const stage = join(sandbox, "package");
  mkdirSync(stage, { recursive: true });
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        engines: pkg.engines,
        dependencies: pkg.dependencies,
      },
      null,
      2,
    ),
  );
  const npm = (...args) => {
    const result = spawnSync("npm", args, { cwd: stage, env, encoding: "utf8", timeout: 300_000 });
    assert.equal(
      result.status,
      0,
      `npm ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  };
  npm("install", "--package-lock-only", "--ignore-scripts");
  npm("shrinkwrap");
  copyFileSync(join(stage, "npm-shrinkwrap.json"), join(root, "npm-shrinkwrap.json"));
  process.stdout.write("wrote npm-shrinkwrap.json\n");
} finally {
  cleanup();
}
