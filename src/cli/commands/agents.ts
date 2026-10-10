import { parseArgs } from "node:util";

import {
  type AgentResult,
  configureAgents,
  detectAgents,
  existingEntry,
} from "../agents/configure.js";
import { agentsWithPlugin } from "../agents/plugins.js";
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
async function askWhich(
  context: CliContext,
  found: AgentTarget[],
  withPlugin: ReadonlySet<AgentId>,
): Promise<AgentTarget[]> {
  const names = found.map((target) => target.name);
  const unticked = found.flatMap((target, index) => (withPlugin.has(target.id) ? [index] : []));
  const ticked = await context.io.choose("Add Knowtarium to which agents?", names, unticked);
  if (ticked !== null) return found.filter((_, index) => ticked.includes(index));
  const asked = found.filter((target) => !withPlugin.has(target.id));
  if (asked.length === 0) return [];
  const question = `Add Knowtarium to ${asked.map((target) => target.name).join(", ")}?`;
  return (await context.io.confirm(question)) ? asked : [];
}

/** Why an agent with the Knowtarium plugin and no entry of its own isn't ticked or added. */
function pluginNote(target: AgentTarget): string {
  const effect = target.id === "codex" ? "replace the plugin's server" : "run a second server";
  return `${target.name} already runs Knowtarium through its plugin, so it isn't ticked: adding it too would ${effect}. To add it anyway: \`knowtarium agents --agent ${target.id}\`.`;
}

/**
 * What happens to the entry of its own an agent with the Knowtarium plugin has (an earlier
 * `connect` wrote it): it is updated like any other, since it runs (in Codex instead of the
 * plugin's server) and an old one may be unsafe, and the person learns how to remove it.
 */
function duplicateNote(target: AgentTarget, path: string): string {
  return target.id === "codex"
    ? `Codex has the Knowtarium plugin and also [mcp_servers.knowtarium] in ${path}, which runs instead of the plugin's server: it is updated like the others. To use the plugin's server, remove that table from the file.`
    : `${target.name} has the Knowtarium plugin and also a Knowtarium entry of its own in ${path}, which runs a second server: it is updated like the others. To keep only the plugin's, run \`claude mcp remove --scope user knowtarium\`.`;
}

/**
 * Adds the MCP server to the detected agents: all with `yes` (or `dryRun`), the named ones with
 * `only`, else the ones the person picks. An agent that has the Knowtarium plugin (Claude Code,
 * Codex) runs the server already: without an entry of its own it starts unticked, and `yes` and
 * `dryRun` leave it out, unless `only` names it; an entry it has is updated like any other, with a
 * note on removing it. Prints what it did (or would do, with `dryRun`).
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
  // An agent with the plugin gets no new entry, but one it has already (from an earlier
  // `connect`) is always updated: it runs, and an old one may run npx in the project folder. An
  // agent named with --agent is added either way: the person asked for it.
  const plugins =
    options.only === undefined ? await agentsWithPlugin(context.env) : new Set<AgentId>();
  const withPlugin = new Set<AgentId>();
  for (const target of chosen) {
    if (!plugins.has(target.id)) continue;
    const entry = await existingEntry(target, server);
    if (entry.found) {
      io.out(duplicateNote(target, entry.path));
    } else {
      withPlugin.add(target.id);
      io.out(pluginNote(target));
    }
  }
  const asksNothing = options.yes === true || options.only !== undefined || options.dryRun === true;
  const picked = asksNothing
    ? chosen.filter((target) => !withPlugin.has(target.id))
    : await askWhich(context, chosen, withPlugin);
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
