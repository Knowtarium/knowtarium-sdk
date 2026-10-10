import { parseArgs } from "node:util";

import { type AgentResult, configureAgents, detectAgents } from "../agents/configure.js";
import {
  commandLine,
  SERVER_NAME,
  type ServerCommand,
  serverCommand,
} from "../agents/server-entry.js";
import { AGENT_IDS, type AgentId, type AgentTarget, agentTargets } from "../agents/targets.js";
import type { CliContext } from "../context.js";

function describe(result: AgentResult): string {
  switch (result.status) {
    case "added":
      return `added to ${result.name} (${result.path})`;
    case "updated":
      return `updated in ${result.name} (${result.path})`;
    case "unchanged":
      return `already in ${result.name}`;
    case "skipped":
      return `skipped ${result.name}: ${result.reason ?? ""}`;
  }
}

/** How to add the MCP server to an agent by hand, for one that was skipped. */
export function handAdd(
  result: AgentResult,
  server: ServerCommand,
  platform: NodeJS.Platform,
): string {
  const args = JSON.stringify(server.args);
  switch (result.agent) {
    case "claude-code":
      return `claude mcp add --scope user ${SERVER_NAME} -- ${commandLine(server, platform)}`;
    case "codex":
      return `in ${result.path}: [mcp_servers.${SERVER_NAME}] command = ${JSON.stringify(server.command)} args = ${args}`;
    case "opencode":
      return `in ${result.path}, under "mcp": "${SERVER_NAME}": { "type": "local", "command": ${JSON.stringify([server.command, ...server.args])}, "enabled": true }`;
    default:
      return `in ${result.path}, under "mcpServers": "${SERVER_NAME}": { "command": ${JSON.stringify(server.command)}, "args": ${args} }`;
  }
}

/**
 * Which of the agents found to add, asked once: a checkbox list with every agent ticked in a
 * terminal, else (stdin or stdout isn't one) a yes-or-no question for all of them.
 */
async function askWhich(context: CliContext, found: AgentTarget[]): Promise<AgentTarget[]> {
  const names = found.map((target) => target.name);
  const ticked = await context.io.choose("Add Knowtarium to which agents?", names);
  if (ticked !== null) return found.filter((_, index) => ticked.includes(index));
  return (await context.io.confirm(`Add Knowtarium to ${names.join(", ")}?`)) ? found : [];
}

/**
 * Adds the MCP server to the detected agents: all with `yes` (or `dryRun`), the named ones with
 * `only`, else the ones the person picks. Prints what it did (or would do, with `dryRun`).
 */
export async function setUpAgents(
  context: CliContext,
  options: {
    readonly yes?: boolean;
    readonly only?: readonly AgentId[];
    readonly dryRun?: boolean;
  },
): Promise<AgentResult[]> {
  const { io } = context;
  const { platform } = context.env;
  const server = serverCommand(context.version, platform, context.env);
  const all = agentTargets(context.env);
  const chosen =
    options.only === undefined
      ? await detectAgents(all)
      : all.filter((target) => options.only?.includes(target.id));
  if (chosen.length === 0) {
    io.out("No supported agent found (Claude Code, Claude Desktop, Cursor, Codex, OpenCode).");
    io.out(`Add this MCP server to your agent by hand: ${commandLine(server, platform)}`);
    return [];
  }
  const picked =
    options.yes === true || options.only !== undefined || options.dryRun === true
      ? chosen
      : await askWhich(context, chosen);
  if (picked.length === 0) {
    io.out("No agent was changed. Run `knowtarium agents` to add Knowtarium later.");
    return [];
  }
  const results = await configureAgents(picked, server, { dryRun: options.dryRun === true });
  for (const result of results) {
    io.out(`${options.dryRun === true ? "would be " : ""}${describe(result)}`);
    if (result.backup !== undefined) io.out(`  previous file saved as ${result.backup}`);
    if (result.status === "skipped")
      io.out(`  add it by hand: ${handAdd(result, server, platform)}`);
  }
  return results;
}

/** `knowtarium agents [--yes] [--dry-run] [--agent <id>]...` */
export async function agentsCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      agent: { type: "string", multiple: true },
    },
  });
  const unknown = (values.agent ?? []).filter(
    (id) => !(AGENT_IDS as readonly string[]).includes(id),
  );
  if (unknown.length > 0) {
    context.io.err(
      `knowtarium agents: unknown agent ${unknown.map((id) => JSON.stringify(id)).join(", ")}. Known agents: ${AGENT_IDS.join(", ")}.`,
    );
    return 2;
  }
  await setUpAgents(context, {
    yes: values.yes ?? false,
    dryRun: values["dry-run"] ?? false,
    ...(values.agent === undefined ? {} : { only: values.agent as AgentId[] }),
  });
  return 0;
}
