import { parseArgs } from "node:util";

import { type AgentResult, configureAgents, detectAgents } from "../agents/configure.js";
import {
  commandLine,
  SERVER_NAME,
  type ServerCommand,
  serverCommand,
} from "../agents/server-entry.js";
import { AGENT_IDS, type AgentId, agentTargets } from "../agents/targets.js";
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
export function handAdd(result: AgentResult, server: ServerCommand): string {
  const args = JSON.stringify(server.args);
  switch (result.agent) {
    case "claude-code":
      return `claude mcp add --scope user ${SERVER_NAME} -- ${commandLine(server)}`;
    case "codex":
      return `in ${result.path}: [mcp_servers.${SERVER_NAME}] command = ${JSON.stringify(server.command)} args = ${args}`;
    case "opencode":
      return `in ${result.path}, under "mcp": "${SERVER_NAME}": { "type": "local", "command": ${JSON.stringify([server.command, ...server.args])}, "enabled": true }`;
    default:
      return `in ${result.path}, under "mcpServers": "${SERVER_NAME}": { "command": ${JSON.stringify(server.command)}, "args": ${args} }`;
  }
}

/**
 * Adds the MCP server to the detected agents: all with `yes`, the named ones with `only`, else
 * after asking once. Prints what it did (or would do, with `dryRun`).
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
  const server = serverCommand(context.version, context.env.platform);
  const all = agentTargets(context.env);
  const chosen =
    options.only === undefined
      ? await detectAgents(all)
      : all.filter((target) => options.only?.includes(target.id));
  if (chosen.length === 0) {
    io.out("No supported agent found (Claude Code, Claude Desktop, Cursor, Codex, OpenCode).");
    io.out(`Add this MCP server to your agent by hand: ${commandLine(server)}`);
    return [];
  }
  const names = chosen.map((target) => target.name).join(", ");
  const go =
    options.yes === true ||
    options.only !== undefined ||
    options.dryRun === true ||
    (await context.io.confirm(`Add Knowtarium to ${names}?`));
  if (!go) {
    io.out("No agent was changed. Run `knowtarium agents` to add Knowtarium later.");
    return [];
  }
  const results = await configureAgents(chosen, server, { dryRun: options.dryRun === true });
  for (const result of results) {
    io.out(`${options.dryRun === true ? "would be " : ""}${describe(result)}`);
    if (result.backup !== undefined) io.out(`  previous file saved as ${result.backup}`);
    if (result.status === "skipped") io.out(`  add it by hand: ${handAdd(result, server)}`);
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
