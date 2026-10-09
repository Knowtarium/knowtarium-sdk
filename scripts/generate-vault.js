// Writes the large generated Obsidian vault the migration tests use (test/large-vault.ts) into a
// new folder, to try `knowtarium convert` on it by hand:
//
//   node scripts/generate-vault.js /tmp/big-vault [--notes 400]
//
// Node runs the TypeScript generator directly (type stripping, Node 24). The folder must not
// exist yet.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { largeVault } from "../test/large-vault.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { notes: { type: "string" } },
});
const [out] = positionals;
if (out === undefined) {
  process.stderr.write("Usage: node scripts/generate-vault.js <new folder> [--notes N]\n");
  process.exit(2);
}
if (existsSync(out)) {
  process.stderr.write(`${out} exists already; pick a new folder.\n`);
  process.exit(1);
}
const vault = largeVault(values.notes === undefined ? {} : { notes: Number(values.notes) });
for (const file of vault.files) {
  const path = join(out, ...file.path.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.data);
}
process.stdout.write(
  `Wrote ${String(vault.files.length)} files (${String(vault.notes.length)} notes, ${String(vault.attachments.length)} attachments) to ${out}\n`,
);
