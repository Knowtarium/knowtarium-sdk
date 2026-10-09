// Vitest setup for every test file (node and dom projects): HOME and every folder the CLI or an
// agent could touch point into a fresh temporary folder, removed after the file's tests, and the
// OS keychain is off, so no test ever reads or writes real agent configs, real Knowtarium files
// or the keychain.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

const root = mkdtempSync(join(tmpdir(), "knowtarium-test-"));
const home = join(root, "home");

Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  KNOWTARIUM_HOME: join(root, "knowtarium"),
  KNOWTARIUM_CACHE: join(root, "knowtarium-cache"),
  KNOWTARIUM_KEYCHAIN: "off",
  KNOWTARIUM_API_URL: "https://api.test",
  KNOWTARIUM_APP_URL: "https://app.test",
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
