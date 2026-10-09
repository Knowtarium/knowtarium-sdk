import { isSyncApiError } from "../client/index.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";

/** Whether Knowtarium refused this version's protocol (`unsupported_protocol`): time to update. */
export function needsUpdate(error: unknown): boolean {
  return isSyncApiError(error, "unsupported_protocol");
}

/**
 * Whether the refusal is the server's lag rather than this version's age: every protocol version
 * the server accepts is older than the one this version speaks (a server not updated yet, or a
 * `KNOWTARIUM_API_URL` pointing at an older one).
 */
export function serverIsBehind(error: unknown): boolean {
  if (!isSyncApiError(error, "unsupported_protocol")) return false;
  const { detail } = error;
  if (detail.code !== "unsupported_protocol" || detail.supportedVersions.length === 0) return false;
  return Math.max(...detail.supportedVersions) < PROTOCOL_VERSION;
}

/** What a command prints when Knowtarium doesn't support this version's protocol. */
export function updateMessage(version: string, error?: unknown): string {
  if (serverIsBehind(error)) {
    return `The Knowtarium server doesn't support this version of knowtarium (${version}) yet: it is behind, not this CLI. Try again later; if you set KNOWTARIUM_API_URL, that server needs updating.`;
  }
  return `Please update knowtarium: this version (${version}) is older than Knowtarium supports. Run the command again with \`npx knowtarium@latest\`, then run \`npx knowtarium@latest agents\` so your agents use the new version too.`;
}

/** The same for an agent, as the MCP server's tool error and status. */
export function mcpUpdateMessage(error?: unknown): string {
  if (serverIsBehind(error)) {
    return "The Knowtarium server doesn't support this version of knowtarium yet (the server is behind, not this one), so it can't sync. Answers come from the local encrypted copy until the server catches up; nothing needs updating on this computer.";
  }
  return "Please update knowtarium: this Knowtarium server is older than Knowtarium supports, so it can't sync. Ask the person to run `npx knowtarium@latest agents` in a terminal (or to update the Knowtarium extension or plugin), then restart the agent. Answers come from the local encrypted copy until then.";
}
