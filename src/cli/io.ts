import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

/** How commands talk to the person; tests pass their own. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Whether a person can answer questions (stdin is a terminal). */
  readonly interactive: boolean;
  /** A yes-or-no question; `false` when there is no terminal to ask in. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
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
    openUrl: openInBrowser,
  };
}
