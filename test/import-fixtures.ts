/// <reference types="vite/types/importMeta.d.ts" />
// The import test vaults in test/fixtures/import (a plain OKF bundle, a messy Obsidian vault and
// an edge-case vault), loaded as the list of files a folder picker or a zip gives the web app.
// Vite inlines them at build time, dot folders included, so no file system is needed.
import type { BundleFile } from "../src/core/index.js";

const PREFIX = "./fixtures/import/";

const files: Record<string, string> = {
  ...import.meta.glob<string>("./fixtures/import/**/*", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>("./fixtures/import/*/.*/**/*", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

/** The test vaults. */
export type ImportFixture = "okf-plain" | "obsidian-messy" | "edge-cases";

/** A vault's files, with paths as a folder picker gives them (`<vault>/<path>`). */
export function importFixture(name: ImportFixture): BundleFile[] {
  return Object.entries(files)
    .filter(([file]) => file.startsWith(`${PREFIX}${name}/`))
    .map(([file, data]) => ({ path: file.slice(PREFIX.length), data }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
