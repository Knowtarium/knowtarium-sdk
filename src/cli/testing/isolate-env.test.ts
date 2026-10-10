import { homedir } from "node:os";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { cliEnvironment } from "../env.js";
import { openSecretStore } from "../storage/secret-store.js";

describe("test isolation", () => {
  it("points HOME, the Knowtarium folders and the keychain away from the real ones", async () => {
    const env = cliEnvironment();
    for (const path of [homedir(), env.home, env.cache, env.userHome]) {
      expect(path.startsWith(tmpdir())).toBe(true);
    }
    expect((await openSecretStore(env.home)).kind).toBe("file");
    expect(env.claudeConfigDir).toBeUndefined();
    expect(env.codexHome).toBeUndefined();
  });
});
