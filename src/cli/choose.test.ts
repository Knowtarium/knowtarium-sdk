import { describe, expect, it } from "vitest";

import {
  type ChoiceKey,
  type ChoiceState,
  choiceLines,
  choiceSummary,
  chosenIndexes,
  pressKey,
  rowsOf,
  startChoice,
} from "./choose.js";

const LABELS = ["Claude Code", "Claude Desktop", "Cursor", "Codex"];

/** The keys as readline's keypress events name them. */
const KEYS: Record<string, ChoiceKey> = {
  up: { name: "up" },
  down: { name: "down" },
  k: { name: "k" },
  j: { name: "j" },
  space: { name: "space" },
  a: { name: "a" },
  enter: { name: "return" },
  escape: { name: "escape" },
  "ctrl+c": { name: "c", ctrl: true },
};

function press(...keys: string[]): ChoiceState {
  return keys.reduce((state, key) => {
    const pressed = KEYS[key];
    if (pressed === undefined) throw new Error(`no key ${key}`);
    return pressKey(state, pressed);
  }, startChoice(LABELS.length));
}

describe("the checkbox list", () => {
  it("starts with every choice ticked, so Enter at once takes them all", () => {
    expect(chosenIndexes(press("enter"))).toEqual([0, 1, 2, 3]);
    expect(choiceLines("Add Knowtarium to which agents?", LABELS, startChoice(4))).toEqual([
      "Add Knowtarium to which agents?  (↑↓ move, space toggle, a all, enter confirm)",
      "❯ ◉ Claude Code",
      "  ◉ Claude Desktop",
      "  ◉ Cursor",
      "  ◉ Codex",
    ]);
  });

  it("moves with the arrows and with k and j, wrapping around", () => {
    expect(press("down").cursor).toBe(1);
    expect(press("j", "j", "k").cursor).toBe(1);
    expect(press("up").cursor).toBe(3);
    expect(press("down", "down", "down", "down").cursor).toBe(0);
  });

  it("toggles the line under the pointer with space", () => {
    const state = press("down", "down", "space");
    expect(state.ticked).toEqual([true, true, false, true]);
    expect(choiceLines("Which?", LABELS, state).slice(1)).toEqual([
      "  ◉ Claude Code",
      "  ◉ Claude Desktop",
      "❯ ◯ Cursor",
      "  ◉ Codex",
    ]);
    expect(press("space", "space").ticked).toEqual([true, true, true, true]);
    expect(chosenIndexes(press("down", "space", "down", "space", "enter"))).toEqual([0, 3]);
  });

  it("unticks all with a when all are ticked, and ticks all otherwise", () => {
    expect(press("a").ticked).toEqual([false, false, false, false]);
    expect(press("a", "a").ticked).toEqual([true, true, true, true]);
    expect(press("space", "a").ticked).toEqual([true, true, true, true]);
  });

  it("confirms with nothing ticked as a choice of none", () => {
    const state = press("a", "enter");
    expect(state.status).toBe("chosen");
    expect(chosenIndexes(state)).toEqual([]);
    expect(choiceSummary("Which?", LABELS, state)).toBe("Which? none");
  });

  it("sums the choice up in one line", () => {
    expect(choiceSummary("Which?", LABELS, press("down", "space", "enter"))).toBe(
      "Which? Claude Code, Cursor, Codex",
    );
  });

  it("cancels with Esc and interrupts with Ctrl+C, taking nothing", () => {
    const cancelled = press("escape");
    expect(cancelled.status).toBe("cancelled");
    expect(chosenIndexes(cancelled)).toEqual([]);
    expect(choiceSummary("Which?", LABELS, cancelled)).toBe("Which? cancelled");
    const interrupted = press("ctrl+c");
    expect(interrupted.status).toBe("interrupted");
    expect(chosenIndexes(interrupted)).toEqual([]);
  });

  it("ignores other keys, and every key once done", () => {
    const start = startChoice(LABELS.length);
    expect(pressKey(start, { name: "x" })).toBe(start);
    expect(pressKey(start, { name: "a", ctrl: true })).toBe(start);
    expect(pressKey(start, {})).toBe(start);
    const done = press("enter");
    expect(pressKey(done, { name: "space" })).toBe(done);
    expect(pressKey(done, { name: "escape" })).toBe(done);
  });

  it("counts the rows lines take when the terminal wraps them", () => {
    expect(rowsOf(["abc", "", "de"], 80)).toBe(3);
    expect(rowsOf(["a".repeat(80)], 80)).toBe(1);
    expect(rowsOf(["a".repeat(81), "b"], 80)).toBe(3);
    expect(rowsOf(["❯ ◉ x".repeat(10)], undefined)).toBe(1);
  });
});
