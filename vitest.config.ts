import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // every test runs with HOME, the Knowtarium folders and the keychain pointed away from
          // the real ones
          setupFiles: ["src/cli/testing/isolate-env.ts"],
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.dom.test.ts"],
        },
      },
      {
        // knowtarium/core, knowtarium/crypto and knowtarium/client run in browsers too: their tests
        // run again under a DOM environment
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          setupFiles: ["src/cli/testing/isolate-env.ts"],
          include: ["src/core/**/*.test.ts", "src/crypto/**/*.test.ts", "src/client/**/*.test.ts"],
        },
      },
    ],
  },
});
