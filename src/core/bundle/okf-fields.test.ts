import { describe, expect, it } from "vitest";

import { firstHeading, firstParagraph } from "./okf-fields.js";

describe("titles and descriptions", () => {
  it("reads the first level-1 heading, without closing hashes", () => {
    expect(firstHeading("intro\n# Pricing ##\ntext")).toBe("Pricing");
    expect(firstHeading("#Hashtag\n## Sub\n#\ttabbed #\n")).toBe("tabbed");
    expect(firstHeading("# C# notes\n")).toBe("C# notes");
    expect(firstHeading("no heading\n")).toBeNull();
  });

  it("stays fast on hostile input", () => {
    const spaces = " \t".repeat(10_000);
    const start = Date.now();
    firstHeading(`#${spaces}a${spaces}#${spaces}x\n`.repeat(5));
    firstParagraph(`${"[[a".repeat(20_000)} [x](${"(".repeat(20_000)}`);
    firstParagraph(`\n${" \t".repeat(20_000)}\n`.repeat(20));
    expect(Date.now() - start).toBeLessThan(200);
  });
});
