// The migration on a large generated vault (test/large-vault.ts): several hundred notes, the same
// names in several folders, attachments, daily notes and templates, a few broken notes.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { largeVault } from "../../../test/large-vault.js";
import { ready } from "../../crypto/index.js";
import { World } from "../../client/testing/world.js";
import { runCli } from "../run.js";
import { listFiles } from "../storage/files.js";
import { temporaryFolder, testContext } from "../testing/context.js";
import { RECORD_PATH, REPORT_PATH } from "./convert.js";
import { validateFolder } from "./validate.js";

const vault = largeVault();
let folder: { path: string; cleanup: () => Promise<void> };
let out = "";
let code = -1;
let printed = "";

beforeAll(async () => {
  await ready();
  folder = await temporaryFolder();
  const root = join(folder.path, "vault");
  for (const file of vault.files) {
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.data);
  }
  out = join(folder.path, "out");
  const context = testContext(folder.path, new World().server.fetch);
  code = await runCli(
    ["convert", root, out, "--person", "maya"],
    () => Promise.resolve(context),
    context.io,
    "0.0.0",
  );
  printed = context.io.lines.join("\n");
}, 120_000);

afterAll(async () => {
  await folder.cleanup();
});

describe("converting a large generated vault", () => {
  it("converts it with every note and attachment in the output", async () => {
    expect(vault.notes.length).toBeGreaterThan(400);
    expect(code).toBe(0);
    const written = new Set(await listFiles(out));
    for (const path of vault.notes) expect(written.has(path), path).toBe(true);
    for (const path of vault.attachments) {
      const original = vault.files.find((file) => file.path === path)?.data;
      const copy = new Uint8Array(await readFile(join(out, ...path.split("/"))));
      expect(copy).toEqual(
        typeof original === "string" ? new TextEncoder().encode(original) : original,
      );
    }
    expect(printed).toMatch(/^Notes: \d+/m);
  });

  it("copies daily notes and templates as they are, and reports the broken notes", async () => {
    const record = JSON.parse(await readFile(join(out, RECORD_PATH), "utf8")) as {
      untouched: string[];
      problems: string[];
    };
    for (const path of [...vault.dailyNotes, ...vault.templates]) {
      expect(record.untouched).toContain(path);
      const original = vault.files.find((file) => file.path === path)?.data;
      expect(await readFile(join(out, ...path.split("/")), "utf8")).toBe(original);
    }
    expect([...record.problems].sort()).toEqual([...vault.brokenFrontmatter].sort());
    // validation fails only on the frontmatter that was already broken in the vault
    const errors = (await validateFolder(out)).filter((finding) => finding.level === "error");
    expect([...new Set(errors.map((finding) => finding.path))].sort()).toEqual(
      [...vault.brokenFrontmatter].sort(),
    );
  });

  it("points ambiguous links at one note and lists them in the report", async () => {
    const report = await readFile(join(out, REPORT_PATH), "utf8");
    for (const name of vault.duplicateNames) {
      expect(report).toContain(`\`[[${name}]]\` now points to`);
    }
    expect(printed).toMatch(/Ambiguous links: \d+/);
  });
});
