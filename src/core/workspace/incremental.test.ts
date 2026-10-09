import { describe, expect, it } from "vitest";

import { budget, measure } from "../../../test/perf-budget.js";

import {
  createWorkspace,
  getNote,
  ghostLinks,
  type NoteInput,
  removeNote,
  upsertNote,
  type Workspace,
} from "../index.js";

/** A deterministic pseudo-random sequence, so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const sorted = <T>(map: ReadonlyMap<string, T>) =>
  [...map.entries()].sort(([a], [b]) => a.localeCompare(b));

/** Everything a workspace derives, in a comparable form. */
function derived(workspace: Workspace) {
  return {
    paths: sorted(workspace.paths),
    folders: sorted(workspace.folders),
    links: sorted(workspace.links),
    backlinks: sorted(workspace.backlinks),
    ghosts: sorted(workspace.ghosts),
    ghostLinks: ghostLinks(workspace),
  };
}

describe("incremental updates", () => {
  it("match a full rebuild after every kind of change", () => {
    const next = random(7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const folders = ["", "a", "a/b", "c"];
    const note = (id: string): NoteInput => {
      const name = pick(names);
      const folder = pick(folders);
      const links = Array.from({ length: 3 }, () =>
        pick([
          `[[${pick(names)}]]`,
          `[[Title ${pick(names)}]]`,
          `[[b/${pick(names)}]]`,
          `[x](${pick(names)}.md)`,
          `[y](/a/${pick(names)}.md)`,
          `[[missing ${pick(names)}]]`,
        ]),
      );
      return {
        id,
        path: folder === "" ? `${name}-${id}.md` : `${folder}/${name}.md`,
        text: `---\ntitle: Title ${pick(names)}\n---\n${links.join("\n")}\n`,
      };
    };

    let inputs = new Map<string, NoteInput>();
    let workspace = createWorkspace([]);
    for (let step = 0; step < 300; step++) {
      const id = `n${String(Math.floor(next() * 25))}`;
      if (next() < 0.2 && inputs.has(id)) {
        inputs.delete(id);
        workspace = removeNote(workspace, id);
      } else {
        const input = note(id);
        const clash = [...inputs.values()].some(
          (other) => other.id !== id && other.path.toLowerCase() === input.path.toLowerCase(),
        );
        if (clash) continue;
        inputs = new Map(inputs).set(id, input);
        workspace = upsertNote(workspace, input);
      }
      expect(derived(workspace), `step ${String(step)}`).toEqual(
        derived(createWorkspace(inputs.values())),
      );
    }
  });

  it("stays fast with a few thousand notes and many ghost links", { timeout: 60_000 }, () => {
    const count = 3000;
    const notes = Array.from({ length: count }, (_, i) => {
      const ghosts = Array.from(
        { length: 10 },
        (_, g) => `[[area/missing-${String(i)}-${String(g)}]]`,
      );
      return {
        id: `n${String(i)}`,
        path: `folder-${String(i % 30)}/sub-${String(i % 7)}/note-${String(i)}.md`,
        text: `---\ntitle: Note ${String(i)}\ngenerated: { by: human:a, at: 2026-09-30T12:00:00Z }\nverified:\n  - { by: human:a, at: 2026-09-30T12:00:00Z }\ntags: [a, b]\n---\n# Note ${String(i)}\n\nSee [[note-${String((i + 1) % count)}]], [[Note ${String((i + 7) % count)}]] and ${ghosts.join(" ")}.\n`,
      };
    });

    // medians after a warm-up; the limits scale with this run's speed (test/perf-budget.ts)
    const { ms: built, result: workspace } = measure(() => createWorkspace(notes), {
      warmups: 1,
      runs: 3,
    });
    expect(workspace.notes.size).toBe(count);
    expect(ghostLinks(workspace)).toHaveLength(count * 10);

    const first = notes[0] as NoteInput;
    const { ms: updated, result: moved } = measure(() => {
      const edited = upsertNote(workspace, { ...first, text: `${first.text}More [[note-5]].\n` });
      const retitled = upsertNote(edited, {
        ...first,
        text: first.text.replace("Note 0", "Zero"),
      });
      return upsertNote(retitled, { ...first, path: "elsewhere/area/missing-9-0.md" });
    });

    expect(getNote(moved, "n0")?.path).toBe("elsewhere/area/missing-9-0.md");
    // n9's link to area/missing-9-0 now resolves; the [[note-0]] link in n2999 turns ghost
    const ghosts = ghostLinks(moved);
    expect(ghosts.filter((link) => link.from === "n9")).toHaveLength(9);
    expect(ghosts.filter((link) => link.from === "n2999").map((link) => link.target)).toContain(
      "note-0",
    );
    expect(ghosts).toHaveLength(count * 10);
    // targets: under a second to build in a browser, a few milliseconds per update; CI gets slack
    expect(built).toBeLessThan(budget(3000));
    expect(updated).toBeLessThan(budget(500));
  });
});
