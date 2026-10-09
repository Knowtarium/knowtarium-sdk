import { describe, expect, it } from "vitest";

import {
  extensionOf,
  fileNameOf,
  folderChain,
  folderOf,
  InvalidPathError,
  normalizePath,
  resolveRelative,
  stemOf,
} from "./index.js";

describe("paths", () => {
  it("normalizes separators and empty segments", () => {
    expect(normalizePath("research\\q3//./pricing.md")).toBe("research/q3/pricing.md");
    expect(normalizePath("./")).toBe("");
  });

  it("normalizes to NFC", () => {
    expect(normalizePath("cafe\u0301.md")).toBe("caf\u00e9.md");
  });

  it.each([
    "/etc/passwd",
    "C:\\notes\\a.md",
    "a/../../b.md",
    "..",
    "a/\u0000.md",
    "a/\u0085.md",
    "a/\u202egpj.md",
    "a/\u2066x.md",
    "notes:stream.md",
    "https://example.com/a.md",
    "folder./a.md",
    "folder /a.md",
    "a.md.",
    "CON",
    "con.md",
    "sub/Nul.txt.md",
    "com1.md",
    "LPT9",
  ])("refuses %j", (path) => {
    expect(() => normalizePath(path)).toThrow(InvalidPathError);
  });

  it.each(["console.md", "com10.md", "lpt.md", "a.b/c.md", ".hidden/a.md"])(
    "accepts %j",
    (path) => {
      expect(normalizePath(path)).toBe(path);
    },
  );

  it("splits paths", () => {
    expect(folderOf("a/b/c.md")).toBe("a/b");
    expect(folderOf("c.md")).toBe("");
    expect(fileNameOf("a/b/c.md")).toBe("c.md");
    expect(stemOf("a/v1.2.md")).toBe("v1.2");
    expect(extensionOf("a/B.MD")).toBe(".md");
    expect(extensionOf("a/.hidden")).toBe("");
    expect(folderChain("a/b")).toEqual(["", "a", "a/b"]);
  });

  it("resolves relative references inside the workspace only", () => {
    expect(resolveRelative("a/b", "../c.md")).toBe("a/c.md");
    expect(resolveRelative("", "./c.md")).toBe("c.md");
    expect(resolveRelative("a", "../../c.md")).toBeNull();
  });
});
