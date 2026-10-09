import type { CliContext } from "./context.js";
import { agentsCommand } from "./commands/agents.js";
import { connectCommand } from "./commands/connect.js";
import { disconnectCommand } from "./commands/disconnect.js";
import { mcpCommand } from "./commands/mcp.js";
import { commandHelp, HELP } from "./commands/help.js";
import { statusCommand } from "./commands/status.js";
import { validateCommand } from "./commands/validate.js";
import { convertCommand } from "./commands/convert.js";
import { needsUpdate, updateMessage } from "./update.js";

type Command = (context: CliContext, argv: readonly string[]) => Promise<number>;

/** Every command by name; `login` is `connect`. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  connect: connectCommand,
  login: connectCommand,
  agents: agentsCommand,
  status: statusCommand,
  disconnect: disconnectCommand,
  validate: validateCommand,
  convert: convertCommand,
  mcp: mcpCommand,
};

/** Runs one command line; resolves with the exit code. */
export async function runCli(
  argv: readonly string[],
  context: () => Promise<CliContext>,
  io: { out(line: string): void; err(line: string): void },
  version: string,
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    io.out(HELP);
    return 0;
  }
  if (name === "--version" || name === "-v") {
    io.out(version);
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    io.err(`knowtarium: unknown command ${JSON.stringify(name)}. Run \`knowtarium help\`.`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(commandHelp(name) ?? HELP);
    return 0;
  }
  try {
    return await command(await context(), rest);
  } catch (error) {
    if (
      error instanceof TypeError &&
      (error as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
    ) {
      io.err(`knowtarium ${name}: ${error.message}`);
      return 2;
    }
    if (needsUpdate(error)) {
      io.err(updateMessage(version, error));
      return 1;
    }
    io.err(`knowtarium ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
