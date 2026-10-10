import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// the sync API imports only knowtarium/protocol, so it must have no code path that could decrypt:
// protocol imports only its own files, never another src/ module (which could reach crypto)
const outsideProtocolImports = {
  regex: "^\\.\\./",
  message: "knowtarium/protocol may only import its own files (./), so it can never reach crypto.",
};
const cryptoLibraryImports = {
  regex: "^(node:)?crypto$|^libsodium",
  message: "knowtarium/protocol must stay free of crypto code.",
};

// knowtarium/clip is the web clipper extension's light entry, on the standard libsodium build: it
// may import its own files and the few crypto files that use no libsodium at all, never the sumo
// build, zod, yaml or anything that could open a clip, a note or a key copy
const outsideClipImports = {
  regex: "^\\.\\./(?!crypto/(encoding|canonical-json|errors|envelope-fields)\\.js$)",
  message:
    "knowtarium/clip may import only its own files and crypto's encoding, canonical-json, errors and envelope-fields.",
};
const clipLibraryImports = {
  regex: "^(node:)?crypto$|^libsodium-wrappers-sumo$|^zod$|^yaml$",
  message:
    "knowtarium/clip runs on the standard libsodium-wrappers build only, without zod or yaml.",
};

// the library runs in browsers, Node and Cloudflare Workers (and later React Native): only the CLI
// may use Node built-ins, and nothing in the library may reach for Node or DOM globals
const nodeImports = {
  regex: "^node:|^(fs|path|os|child_process|crypto|stream|buffer|url|util|process)(/.*)?$",
  message: "The library is platform neutral: Node built-ins belong in src/cli only.",
};
const platformGlobals = [
  "process",
  "Buffer",
  "require",
  "__dirname",
  "__filename",
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
].map((name) => ({ name, message: "The library is platform neutral: no Node or DOM globals." }));

export default defineConfig(
  globalIgnores(["**/dist/", "**/dist-extras/", "**/coverage/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["src/**", "test/**"],
    ignores: ["src/cli/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [nodeImports] }],
      "no-restricted-globals": ["error", ...platformGlobals],
    },
  },
  {
    files: ["src/protocol/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [outsideProtocolImports, cryptoLibraryImports, nodeImports] },
      ],
    },
  },
  {
    files: ["src/clip/**"],
    ignores: ["src/clip/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [outsideClipImports, clipLibraryImports, nodeImports] },
      ],
    },
  },
  prettier,
);
