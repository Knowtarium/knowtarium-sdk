import { parseArgs } from "node:util";

import { isSyncApiError, NetworkError } from "../../client/index.js";
import { describeAgentChanges, readAgentChanges } from "../agent-changes.js";
import { ConnectError, runConnect } from "../connect/flow.js";
import type { CliContext } from "../context.js";
import { needsUpdate, updateMessage } from "../update.js";
import { setUpAgents } from "./agents.js";

/** `knowtarium connect [--no-agents] [--yes] [--dry-run]` (also `knowtarium login`). */
export async function connectCommand(
  context: CliContext,
  argv: readonly string[],
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "no-agents": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
    },
  });
  const { io } = context;
  try {
    const delivered = await runConnect({
      apiUrl: context.env.apiUrl,
      appUrl: context.env.appUrl,
      cliVersion: context.version,
      fetch: context.fetch,
      credentials: await context.credentials(),
      trust: context.trust,
      openUrl: (url) => io.openUrl(url),
      print: (line) => {
        io.out(line);
      },
      interactive: io.interactive,
      confirm: (question) => io.confirm(question, false),
    });
    const { connection } = delivered;
    const changes = await readAgentChanges(connection, {
      fetch: context.fetch,
      trust: context.trust,
    });
    io.out(`Connected to workspace ${connection.workspaceId} (${describeAgentChanges(changes)}).`);
    if ((await context.secrets()).kind === "file") {
      io.out(
        "No OS keychain was available: the key is in a private file in the Knowtarium folder.",
      );
    }
  } catch (error) {
    if (error instanceof ConnectError) {
      io.err(error.message);
      return 1;
    }
    if (error instanceof NetworkError || (isSyncApiError(error) && error.status >= 500)) {
      io.err(
        `Knowtarium can't be reached at ${context.env.apiUrl} right now. Check the internet connection (and KNOWTARIUM_API_URL, if you set it), then run \`knowtarium connect\` again.`,
      );
      return 1;
    }
    if (needsUpdate(error)) {
      io.err(updateMessage(context.version, error));
      return 1;
    }
    if (isSyncApiError(error)) {
      io.err(`The Knowtarium API refused the request (${error.code}).`);
      return 1;
    }
    throw error;
  }
  if (values["no-agents"] !== true) {
    await setUpAgents(context, { yes: values.yes ?? false, dryRun: values["dry-run"] ?? false });
  }
  return 0;
}
