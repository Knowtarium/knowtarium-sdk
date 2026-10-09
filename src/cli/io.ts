import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

import {
  type ChoiceKey,
  choiceLines,
  choiceSummary,
  chosenIndexes,
  pressKey,
  rowsOf,
  startChoice,
} from "./choose.js";

/** How commands talk to the person; tests pass their own. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Whether a person can answer questions (stdin is a terminal). */
  readonly interactive: boolean;
  /** A yes-or-no question; `false` when there is no terminal to ask in. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /**
   * A checkbox list of `labels`, all ticked: the indexes the person keeps, none when they cancel.
   * Null when there is no terminal to show it in (stdin or stdout isn't one): ask with `confirm`.
   */
  choose(question: string, labels: readonly string[]): Promise<number[] | null>;
  openUrl(url: string): Promise<void>;
}

/**
 * The platform's URL opener. On Windows it is `rundll32 url.dll,FileProtocolHandler`, which takes
 * the URL as one argument: `cmd /c start` would split it at the `&` in the fragment.
 */
export function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): readonly [string, readonly string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Opens a URL with the platform's own opener, without waiting for the browser. */
function openInBrowser(url: string): Promise<void> {
  const [command, args] = browserCommand(process.platform, url);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { stdio: "ignore", detached: true });
      child.on("error", () => {
        resolve();
      });
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** Clears from the cursor to the end of the screen. */
const CLEAR_DOWN = "\x1b[0J";

/** Signals that end the process while the list is up: the terminal is put back first. */
const ENDING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The checkbox list in the terminal: raw mode, keys from readline's keypress events, the list
 * drawn again in place after each key and replaced by a one-line summary at the end. Raw mode
 * and the cursor are always put back, also on an error or a signal. Ctrl+C (which raw mode turns
 * into a key) puts them back, then interrupts the process as Ctrl+C does anywhere else.
 */
function chooseInTerminal(question: string, labels: readonly string[]): Promise<number[] | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let state = startChoice(labels.length);
    let rows = 0;
    const draw = (lines: readonly string[]) => {
      // back to the start of what was drawn, cleared, so no line of it is left behind
      const back = rows === 0 ? "" : `\r${rows > 1 ? `\x1b[${String(rows - 1)}A` : ""}`;
      stdout.write(`${back}${CLEAR_DOWN}${lines.join("\n")}`);
      rows = rowsOf(lines, stdout.columns);
    };
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      stdin.off("keypress", onKey);
      for (const signal of ENDING_SIGNALS) process.off(signal, onSignal);
      try {
        stdin.setRawMode(wasRaw);
      } finally {
        stdin.pause();
        stdout.write(SHOW_CURSOR);
      }
    };
    const onSignal = (signal: NodeJS.Signals) => {
      restore();
      stdout.write("\n");
      // with the terminal back, the signal does what it would have done
      process.kill(process.pid, signal);
    };
    const onKey = (_text: string | undefined, key: ChoiceKey | undefined) => {
      try {
        state = pressKey(state, key ?? {});
        if (state.status === "choosing") {
          draw(choiceLines(question, labels, state));
          return;
        }
        draw([choiceSummary(question, labels, state)]);
        stdout.write("\n");
        restore();
        if (state.status === "interrupted") process.kill(process.pid, "SIGINT");
        else resolve(chosenIndexes(state));
      } catch (error) {
        restore();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    try {
      emitKeypressEvents(stdin);
      for (const signal of ENDING_SIGNALS) process.on(signal, onSignal);
      stdin.setRawMode(true);
      stdout.write(HIDE_CURSOR);
      draw(choiceLines(question, labels, state));
      stdin.on("keypress", onKey);
      stdin.resume();
    } catch (error) {
      restore();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** The real terminal. Output goes to stderr when stdout carries data (the MCP server). */
export function terminalIo(): CliIo {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    // `isTTY` is undefined (not false) when stdin isn't a terminal
    interactive: (process.stdin as { isTTY?: boolean }).isTTY === true,
    confirm: async (question, defaultYes = true) => {
      if (!process.stdin.isTTY) return false;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await prompt.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `))
          .trim()
          .toLowerCase();
        return answer === "" ? defaultYes : answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    },
    choose: chooseInTerminal,
    openUrl: openInBrowser,
  };
}
