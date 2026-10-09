// The Obsidian migration skill (skills/obsidian-to-okf) checked against the CLI it drives: its
// frontmatter, the commands and flags it runs, and the report sections it explains.
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseNote } from "../../core/index.js";
import { COMMANDS } from "../run.js";

const SKILL = "skills/obsidian-to-okf/SKILL.md";

describe("the Obsidian migration skill", () => {
  it("has the frontmatter Claude skills need and no em dashes", async () => {
    const skill = await readFile(SKILL, "utf8");
    const data = parseNote(skill).frontmatter?.data ?? {};
    expect(data["name"]).toBe("obsidian-to-okf");
    expect(String(data["description"]).length).toBeGreaterThan(50);
    expect(String(data["description"]).length).toBeLessThan(1024);
    expect(skill).not.toContain("—");
  });

  it("runs only commands and flags the CLI has, and explains every report section", async () => {
    const skill = await readFile(SKILL, "utf8");
    const commands = [...skill.matchAll(/npx knowtarium (\w+)/g)].map((match) => match[1] ?? "");
    expect(new Set(commands)).toEqual(new Set(["convert", "validate"]));
    for (const command of commands) expect(COMMANDS[command]).toBeDefined();
    const convert = await readFile("src/cli/commands/convert.ts", "utf8");
    // each flag is a parseArgs option of the command (`person: { type`, `"dry-run": { type`)
    for (const flag of skill.matchAll(/ --([a-z][a-z-]*)/g)) {
      const name = flag[1] ?? "";
      expect(convert.includes(`${name}: { type`) || convert.includes(`"${name}": { type`)).toBe(
        true,
      );
    }
    const table = skill.slice(skill.indexOf("## Reading the report"));
    const sections = [...table.matchAll(/^\| ([A-Z][a-z ]+?)\s+\|/gm)]
      .map((match) => match[1] ?? "")
      .filter((name) => name !== "Section");
    expect(sections.length).toBeGreaterThanOrEqual(8);
    for (const section of sections) expect(convert).toContain(`"${section}"`);
  });
});
