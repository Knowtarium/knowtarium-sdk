// The checkbox list `connect` and `agents` show to pick agents: what each key does and what the
// list looks like, apart from the terminal (which io.ts drives), so tests can press keys.

/** A key, as readline's `keypress` event describes it. */
export interface ChoiceKey {
  readonly name?: string | undefined;
  readonly ctrl?: boolean | undefined;
}

/** Where a checkbox list stands. */
export interface ChoiceState {
  /** The line the pointer is on. */
  readonly cursor: number;
  readonly ticked: readonly boolean[];
  /** `choosing` until Enter (`chosen`), Esc (`cancelled`) or Ctrl+C (`interrupted`). */
  readonly status: "choosing" | "chosen" | "cancelled" | "interrupted";
}

/** What the first line tells the person they can press. */
export const CHOICE_KEYS = "(↑↓ move, space toggle, a all, enter confirm)";

/** A list of `count` choices, all ticked, so Enter at once takes them all. */
export function startChoice(count: number): ChoiceState {
  return { cursor: 0, ticked: Array.from({ length: count }, () => true), status: "choosing" };
}

/**
 * The list after one key: up and down (or k and j) move, wrapping around; space ticks or unticks
 * the line; `a` ticks every line, or unticks them all when all are ticked; Enter confirms, Esc
 * cancels and Ctrl+C interrupts. Other keys, and any key once the list is done, change nothing.
 */
export function pressKey(state: ChoiceState, key: ChoiceKey): ChoiceState {
  if (state.status !== "choosing") return state;
  const count = state.ticked.length;
  if (key.ctrl === true) return key.name === "c" ? { ...state, status: "interrupted" } : state;
  switch (key.name) {
    case "up":
    case "k":
      return count === 0 ? state : { ...state, cursor: (state.cursor - 1 + count) % count };
    case "down":
    case "j":
      return count === 0 ? state : { ...state, cursor: (state.cursor + 1) % count };
    case "space":
      return {
        ...state,
        ticked: state.ticked.map((ticked, index) => (index === state.cursor ? !ticked : ticked)),
      };
    case "a": {
      const all = state.ticked.every(Boolean);
      return { ...state, ticked: state.ticked.map(() => !all) };
    }
    case "return":
    case "enter":
      return { ...state, status: "chosen" };
    case "escape":
      return { ...state, status: "cancelled" };
    default:
      return state;
  }
}

/** The indexes taken: the ticked ones once confirmed, none when cancelled or interrupted. */
export function chosenIndexes(state: ChoiceState): number[] {
  if (state.status !== "chosen") return [];
  return state.ticked.flatMap((ticked, index) => (ticked ? [index] : []));
}

/** The lines the list shows while choosing: the question, then a line per choice. */
export function choiceLines(
  question: string,
  labels: readonly string[],
  state: ChoiceState,
): string[] {
  return [
    `${question}  ${CHOICE_KEYS}`,
    ...labels.map(
      (label, index) =>
        `${index === state.cursor ? "❯" : " "} ${state.ticked[index] === true ? "◉" : "◯"} ${label}`,
    ),
  ];
}

/** The one line left in place of the list once it is done. */
export function choiceSummary(
  question: string,
  labels: readonly string[],
  state: ChoiceState,
): string {
  if (state.status !== "chosen") return `${question} cancelled`;
  const names = chosenIndexes(state).map((index) => labels[index]);
  return `${question} ${names.length === 0 ? "none" : names.join(", ")}`;
}

/**
 * How many terminal rows `lines` take at `columns` wide (a long line wraps onto more). Counted in
 * code points: the list's symbols and agent names each take one column.
 */
export function rowsOf(lines: readonly string[], columns: number | undefined): number {
  const width = columns === undefined || columns < 1 ? Infinity : columns;
  return lines.reduce(
    (rows, line) => rows + Math.max(1, Math.ceil(Array.from(line).length / width)),
    0,
  );
}
