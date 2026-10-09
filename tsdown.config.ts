import { defineConfig } from "tsdown";

import pkg from "./package.json" with { type: "json" };

/**
 * package.json is the one list of entries: every `./dist/<name>.js` it names in "exports" or "bin"
 * is built from `src/<name>.ts`.
 */
function entriesFor(targets: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    targets.map((target) => {
      const name = /^\.\/dist\/(.+)\.js$/.exec(target)?.[1];
      if (name === undefined) throw new Error(`${target} is not a ./dist/<name>.js path`);
      return [name, `src/${name}.ts`];
    }),
  );
}

const libraryTargets = Object.values(pkg.exports).flatMap((target) =>
  typeof target === "string" ? [] : [target.default],
);

const shared = {
  format: "esm",
  target: "es2023",
  // .js and .d.ts, as package.json "exports" expects ("type": "module")
  fixedExtension: false,
} as const;

export default defineConfig([
  {
    ...shared,
    // the library runs in browsers, Node and Cloudflare Workers
    entry: entriesFor(libraryTargets),
    platform: "neutral",
    tsconfig: "src/tsconfig.json",
    dts: true,
  },
  {
    ...shared,
    // the knowtarium binary runs only in Node and is not imported, so it needs no types
    entry: entriesFor(Object.values(pkg.bin)),
    platform: "node",
    tsconfig: "src/cli/tsconfig.json",
    dts: false,
  },
]);
