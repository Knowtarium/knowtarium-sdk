import { describe, expect, it } from "vitest";

import { fixtureText } from "../../../test/fixture-workspace.js";
import { parseNote } from "../note/index.js";
import { OKF_FIELDS, parseOkfTimestamp, validateFrontmatter } from "./index.js";

function dataOf(path: string): Readonly<Record<string, unknown>> {
  return parseNote(fixtureText(path)).frontmatter?.data ?? {};
}

describe("validateFrontmatter", () => {
  it("covers the OKF fields the app reads", () => {
    expect(OKF_FIELDS).toEqual([
      "title",
      "description",
      "type",
      "status",
      "generated",
      "verified",
      "stale_after",
      "sources",
      "tags",
    ]);
  });

  it("types the valid fields of a full note", () => {
    const { version, fields, problems } = validateFrontmatter(dataOf("research/churn.md"));
    expect(version).toBe("0.2");
    expect(problems).toEqual([]);
    expect(fields.generated).toEqual({ by: "claude-code/2.1", at: "2026-09-26T08:10:00Z" });
    expect(fields.verified).toHaveLength(1);
    expect(fields.sources?.[0]).toMatchObject({
      id: "billing-export",
      author: "process:billing-sync",
    });
  });

  it("allows unknown keys and unknown types, and never strips anything", () => {
    const data = dataOf("notes/custom-keys.md");
    const copy: unknown = JSON.parse(JSON.stringify(data));
    const { fields, problems } = validateFrontmatter(data);
    expect(problems).toEqual([]);
    expect(fields.type).toBe("Meeting");
    expect(fields.stale_after).toBe("2027-01-31");
    expect(fields).not.toHaveProperty("owner");
    expect(data).toEqual(copy);
    expect(data["owner"]).toEqual({ name: "Sara", team: "growth" });
  });

  it("reports each invalid field with its path, keeping the valid ones", () => {
    const { fields, problems } = validateFrontmatter({
      title: "Fine",
      generated: { by: "", at: "yesterday" },
      verified: [{ by: "human:a", at: "2026-09-01" }, { by: "human:b" }],
      stale_after: "2026-02-30",
      tags: [1, "a"],
      sources: "none",
    });
    expect(fields).toEqual({ title: "Fine", tags: ["1", "a"] });
    expect(problems.map((problem) => problem.field)).toEqual([
      "generated.by",
      "generated.at",
      "verified.1.at",
      "stale_after",
      "sources",
    ]);
  });

  it("treats null as missing and reads a single tag or a numeric title", () => {
    const { fields, problems } = validateFrontmatter({ title: 2024, description: null, tags: "x" });
    expect(problems).toEqual([]);
    expect(fields).toEqual({ title: "2024", tags: ["x"] });
  });
});

describe("parseOkfTimestamp", () => {
  it.each([
    ["2026-09-26", Date.UTC(2026, 8, 26)],
    ["2026-09-26T08:10:00Z", Date.UTC(2026, 8, 26, 8, 10)],
    ["2026-09-26T10:10:00+02:00", Date.UTC(2026, 8, 26, 8, 10)],
    ["2026-09-26 08:10:00", Date.UTC(2026, 8, 26, 8, 10)],
    ["2026-09-26t08:10:00.5z", Date.UTC(2026, 8, 26, 8, 10, 0, 500)],
    ["2026-09-26 03:10:00 -0500", Date.UTC(2026, 8, 26, 8, 10)],
  ])("reads %s", (value, expected) => {
    expect(parseOkfTimestamp(value)).toBe(expected);
  });

  it.each(["", "yesterday", "2026-13-01", "2026-02-30", "2026-09-26T25:00:00Z", "26/09/2026"])(
    "refuses %j",
    (value) => {
      expect(parseOkfTimestamp(value)).toBeNull();
    },
  );
});
