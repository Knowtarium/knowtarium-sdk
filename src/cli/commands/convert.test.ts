import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ready } from "../../crypto/index.js";
import { World } from "../../client/testing/world.js";
import { runCli } from "../run.js";
import { listFiles } from "../storage/files.js";
import { temporaryFolder, testContext } from "../testing/context.js";
import { createOutput, OutputRefused } from "../convert/output.js";
import { convertVault, RECORD_PATH, REPORT_PATH, writeConversion } from "./convert.js";
import { validateFolder } from "./validate.js";

beforeAll(ready);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const VAULTS = ["okf-plain", "obsidian-messy", "edge-cases"] as const;
/** Symbolic links and POSIX permissions: Windows needs extra rights for both, so they run elsewhere. */
const posix = it.skipIf(process.platform === "win32");
const vaultPath = (name: string) => join("test/fixtures/import", name);

async function setup() {
  const folder = await temporaryFolder();
  cleanup = folder.cleanup;
  const context = testContext(folder.path, new World().server.fetch);
  const run = (...argv: string[]) =>
    runCli(argv, () => Promise.resolve(context), context.io, "0.0.0");
  return { folder: folder.path, context, run };
}

/** Every file of a folder with its hash, to show it didn't change. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await listFiles(root)) {
    files[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  return files;
}

describe("knowtarium convert", () => {
  for (const vault of VAULTS) {
    it(`converts ${vault} into a valid OKF bundle in a new folder, leaving the vault as it was`, async () => {
      const { folder, context, run } = await setup();
      const out = join(folder, "out");
      const before = await snapshot(vaultPath(vault));
      expect(await run("convert", vaultPath(vault), out, "--person", "maya")).toBe(0);
      expect(await snapshot(vaultPath(vault))).toEqual(before);
      // the terminal gets a summary; the full report is saved
      const printed = context.io.lines.join("\n");
      expect(printed).toMatch(/^Notes: \d+/m);
      expect(printed).toContain("Full report:");
      expect(printed).not.toContain("# Conversion report");

      const report = await readFile(join(out, REPORT_PATH), "utf8");
      const record = JSON.parse(await readFile(join(out, RECORD_PATH), "utf8")) as {
        untouched: string[];
        problems: string[];
      };
      // every note and attachment of the vault is in the output (renamed ones under their new name)
      const written = await listFiles(out);
      for (const path of Object.keys(before)) {
        if (/^\.(obsidian|trash)\//.test(path) || /(^|\/)(index|log)\.md$/.test(path)) continue;
        expect(written).toContain(path);
      }
      // validation: errors only for frontmatter that was already broken in the vault, warnings
      // only for links that were already broken and notes copied unchanged
      const findings = await validateFolder(out);
      const errors = findings.filter((finding) => finding.level === "error");
      expect(errors.map((finding) => finding.path).sort()).toEqual([...record.problems].sort());
      for (const warning of findings.filter((finding) => finding.level === "warning")) {
        const known =
          record.untouched.includes(warning.path) ||
          report.includes(warning.message.split(" ")[0] ?? "");
        expect(known, `${warning.path}: ${warning.message}`).toBe(true);
      }
    });
  }

  it("generates the OKF fields, renames reserved names, keeps Obsidian's settings", async () => {
    const { folder, run } = await setup();
    const out = join(folder, "out");
    expect(await run("convert", vaultPath("obsidian-messy"), out, "--person", "maya")).toBe(0);
    const pricing = await readFile(join(out, "Pricing.md"), "utf8");
    expect(pricing).toMatch(/type: /);
    expect(pricing).toMatch(/generated: \{ by: human:maya, at: /);
    expect(pricing).not.toMatch(/stale_after/);
    expect(await readdir(join(out, "Projects"))).toContain("index-note.md");
    expect(await readdir(join(out, ".obsidian"))).toContain("app.json");
    // the raw vault doesn't pass: the conversion is what makes it OKF
    const raw = await validateFolder(vaultPath("obsidian-messy"));
    expect(raw.some((finding) => finding.level === "error")).toBe(true);
  });

  it("reports Obsidian's settings as copied, and takes an empty .obsidian as a vault", async () => {
    const { folder, context, run } = await setup();
    const out = join(folder, "out");
    expect(await run("convert", vaultPath("obsidian-messy"), out, "--person", "maya")).toBe(0);
    const report = await readFile(join(out, REPORT_PATH), "utf8");
    const settings = report.slice(report.indexOf("## Obsidian settings"));
    expect(settings.slice(0, settings.indexOf("\n## ", 4))).toContain("`.obsidian/app.json`");
    const skipped = report.slice(report.indexOf("## Skipped"));
    expect(skipped.slice(0, skipped.indexOf("\n## ", 4))).not.toContain(".obsidian/");
    expect(context.io.lines.join("\n")).toMatch(/Obsidian settings copied: \d+/);

    const vault = join(folder, "empty-settings");
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await writeFile(join(vault, "Welcome.md"), "Hello [[Other]].\n");
    await writeFile(join(vault, "Other.md"), "Other note.\n");
    const conversion = await convertVault(await realpath(vault), {
      person: "human:maya",
      at: new Date(),
    });
    expect(conversion.result.report.source).toBe("obsidian");
  });

  it("dry runs, and refuses a non-empty output, the vault itself or no person", async () => {
    const { folder, context, run } = await setup();
    const out = join(folder, "out");
    expect(
      await run("convert", vaultPath("obsidian-messy"), out, "--person", "maya", "--dry-run"),
    ).toBe(0);
    expect(context.io.lines.at(-1)).toMatch(/Dry run: nothing was written/);
    expect(await readdir(folder)).not.toContain("out");

    await mkdir(out);
    await writeFile(join(out, "keep.txt"), "x");
    expect(await run("convert", vaultPath("okf-plain"), out, "--person", "maya")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/isn't empty/);
    expect(
      await run(
        "convert",
        vaultPath("okf-plain"),
        join(vaultPath("okf-plain"), "out"),
        "--person",
        "maya",
      ),
    ).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/separate folder/);
    expect(await run("convert", vaultPath("okf-plain"), join(folder, "other"))).toBe(2);
  });
});

describe("knowtarium convert keeps the vault safe", () => {
  /** A writable copy of a fixture vault in the test's folder, under `name`. */
  async function vaultCopy(folder: string, name = "Vault") {
    const vault = join(folder, name);
    await cp(vaultPath("obsidian-messy"), vault, { recursive: true });
    return vault;
  }

  posix("refuses an output inside the vault through a symlinked parent", async () => {
    const { folder, context, run } = await setup();
    const vault = await vaultCopy(folder);
    await symlink(vault, join(folder, "link"));
    const before = await snapshot(vault);
    expect(await run("convert", vault, join(folder, "link", "out"), "--person", "maya")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/separate folder/);
    expect(await run("convert", join(folder, "link"), join(vault, "x"), "--person", "maya")).toBe(
      1,
    );
    expect(await snapshot(vault)).toEqual(before);
    expect(await readdir(vault)).not.toContain("out");
  });

  it("refuses an output inside the vault through another spelling of the temp folder", async () => {
    const { folder, run } = await setup();
    const vault = await vaultCopy(folder);
    const real = await realpath(vault);
    // /var/folders against /private/var/folders on macOS; the same path elsewhere
    expect(await run("convert", real, join(vault, "out"), "--person", "maya")).toBe(1);
    expect(await run("convert", vault, join(real, "out"), "--person", "maya")).toBe(1);
    expect(await readdir(vault)).not.toContain("out");
  });

  it("refuses an output inside the vault spelled in another letter case", async () => {
    const { folder, run } = await setup();
    const vault = await vaultCopy(folder);
    const other = join(folder, "VAULT");
    const insensitive = (await stat(other).catch(() => null)) !== null;
    if (!insensitive) return; // a case-sensitive volume: VAULT is another folder
    expect(await run("convert", vault, join(other, "out"), "--person", "maya")).toBe(1);
    expect(await run("convert", vault, join(folder, "vault"), "--person", "maya")).toBe(1);
    expect(await readdir(vault)).not.toContain("out");
  });

  posix("follows no symlinks, reads no hidden folders, and reports what it left out", async () => {
    const { folder, run } = await setup();
    const vault = await vaultCopy(folder);
    const secret = join(folder, "secret.md");
    await writeFile(secret, "outside the vault");
    await symlink(secret, join(vault, "Linked.md"));
    await symlink(folder, join(vault, "Up"));
    await mkdir(join(vault, ".git"));
    await writeFile(join(vault, ".git", "HEAD"), "ref");
    await symlink(secret, join(vault, ".obsidian", "linked.json"));
    const locked = join(vault, "Locked");
    await mkdir(locked);
    await writeFile(join(locked, "Hidden note.md"), "x");
    await chmod(locked, 0o000);
    try {
      const out = join(folder, "out");
      expect(await run("convert", vault, out, "--person", "maya")).toBe(0);
      const written = await listFiles(out);
      expect(written).not.toContain("Linked.md");
      expect(written.some((path) => path.startsWith("Up/"))).toBe(false);
      expect(written.some((path) => path.startsWith(".git/"))).toBe(false);
      expect(written).not.toContain(".obsidian/linked.json");
      expect(written).toContain(".obsidian/app.json");
      const report = await readFile(join(out, REPORT_PATH), "utf8");
      expect(report).toContain("`Linked.md`: A symbolic link");
      expect(report).toContain("`Up`: A symbolic link");
      expect(report).toContain("`.git/`: A hidden folder");
      expect(report).toContain("`.obsidian/linked.json`: A symbolic link");
      if (process.getuid?.() !== 0) expect(report).toContain("`Locked`: Couldn't be read");
    } finally {
      await chmod(locked, 0o755);
    }
  });

  posix(
    "refuses a folder that appears where it planned to create one, never following it",
    async () => {
      const { folder } = await setup();
      const vault = await vaultCopy(folder);
      const vaultReal = await realpath(vault);
      const out = join(folder, "new", "out");
      const attempt = createOutput(vaultReal, out, {
        afterPlan: async () => {
          await mkdir(join(folder, "new"));
          await symlink(vault, join(folder, "new", "out"));
        },
      });
      await expect(attempt).rejects.toBeInstanceOf(OutputRefused);
      expect(await readdir(vault)).not.toContain("out");
    },
  );

  posix("refuses to write through a folder swapped for a link mid-write", async () => {
    const { folder } = await setup();
    const vault = await vaultCopy(folder);
    const vaultReal = await realpath(vault);
    const outReal = await createOutput(vaultReal, join(folder, "out"));
    const conversion = await convertVault(vaultReal, { person: "human:maya", at: new Date() });
    const before = await snapshot(vault);
    let swapped = false;
    const writing = writeConversion(vaultReal, outReal, conversion, {
      vault,
      at: new Date(),
      hooks: {
        beforeWrite: async (path) => {
          if (swapped || !path.startsWith("Projects/")) return;
          swapped = true;
          await rm(join(outReal, "Projects"), { recursive: true });
          await symlink(join(vault, "Projects"), join(outReal, "Projects"));
        },
      },
    });
    await expect(writing).rejects.toBeInstanceOf(OutputRefused);
    expect(swapped).toBe(true);
    expect(await snapshot(vault)).toEqual(before);
  });

  posix("refuses a dangling link as the output, and warns about hard-linked files", async () => {
    const { folder, context, run } = await setup();
    const vault = await vaultCopy(folder);
    await symlink(join(folder, "nowhere"), join(folder, "dangling"));
    expect(await run("convert", vault, join(folder, "dangling"), "--person", "maya")).toBe(1);
    expect(context.io.errors.at(-1)).toMatch(/symbolic link/);
    await link(join(vault, "Pricing.md"), join(folder, "pricing-elsewhere.md"));
    const out = join(folder, "out");
    expect(await run("convert", vault, out, "--person", "maya")).toBe(0);
    expect(context.io.lines.join("\n")).toContain(await realpath(out));
    const report = await readFile(join(out, REPORT_PATH), "utf8");
    expect(report).toContain("## Hard-linked files");
    expect(report).toContain("`Pricing.md`: Has 1 other hard link(s)");
  });
});
