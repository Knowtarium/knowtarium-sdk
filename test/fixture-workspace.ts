/// <reference types="vite/types/importMeta.d.ts" />
// The fixture workspace in test/fixtures/workspace, loaded the way the app loads a workspace:
// decrypted note texts with ids and paths, no file system. Vite inlines the files at build time,
// so this helper works in Node and in a browser test runner alike.
import { createWorkspace, type NoteInput, type Workspace } from "../src/core/index.js";

const PREFIX = "./fixtures/workspace/";

const files = import.meta.glob<string>("./fixtures/workspace/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The fixture note id for a path: ids differ from paths on purpose, as in the real app. */
export function fixtureId(path: string): string {
  return `note:${path}`;
}

/** Every fixture note as a `NoteInput`, sorted by path. */
export function fixtureNotes(): NoteInput[] {
  return Object.entries(files)
    .map(([file, text]) => {
      const path = file.slice(PREFIX.length);
      return { id: fixtureId(path), path, text };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The text of one fixture note, byte for byte. */
export function fixtureText(path: string): string {
  const text = files[PREFIX + path];
  if (text === undefined) throw new Error(`No fixture note at ${path}`);
  return text;
}

/** The fixture workspace, built with `createWorkspace`. */
export function loadFixtureWorkspace(): Workspace {
  return createWorkspace(fixtureNotes());
}

/**
 * The verification state each fixture note is in, by the rules in the data-and-storage doc (a
 * check counts only if it is at or after `generated.at`; stale overrides everything). For the
 * verification module (t-18) to assert against; the conflict state comes from agent check
 * records, not frontmatter, so no fixture note is in it.
 */
export const FIXTURE_VERIFICATION_STATES = {
  "research/pricing.md": "fully-verified",
  "research/competitors.md": "agent-check-pending",
  "research/churn.md": "waiting-for-human",
  "decisions/old-review.md": "waiting-for-human",
  "notes/custom-keys.md": "waiting-for-human",
  "decisions/annual-plans.md": "stale",
} as const;
