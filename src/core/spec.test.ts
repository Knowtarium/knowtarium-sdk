import { describe, expect, it } from "vitest";

import { isReservedFile, OKF_SPEC_VERSION } from "./index.js";

describe("spec", () => {
  it("targets OKF v0.2", () => {
    expect(OKF_SPEC_VERSION).toBe("0.2");
  });

  it.each(["index.md", "log.md", "./index.md", ".\\log.md", "notes/index.md", "a\\b\\log.md"])(
    "treats %s as reserved in its folder",
    (path) => {
      expect(isReservedFile(path)).toBe(true);
    },
  );

  it.each(["INDEX.md", "notes/Log.md", "readme.md", "index.md/", "my-index.md", ""])(
    "does not treat %s as reserved",
    (path) => {
      expect(isReservedFile(path)).toBe(false);
    },
  );
});
